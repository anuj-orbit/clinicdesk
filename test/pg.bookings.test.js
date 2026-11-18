// Area B (B2) — Postgres bookings repo integration + memory repo unit test.
//
// The Postgres suite is skipped unless TEST_DATABASE_URL is set. It runs in an
// isolated schema (never touches shared tables) so node --test's parallel
// processes don't collide.
import { describe, it, test, before, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import pg from "pg";

import { ConflictError, ValidationError } from "../src/errors.js";
import { pgAvailabilityRepo } from "../src/data/pg/availability.js";
import { pgBookingsRepo } from "../src/data/pg/bookings.js";
import { memoryAvailabilityRepo } from "../src/data/memory/availability.js";
import { memoryBookingsRepo } from "../src/data/memory/bookings.js";
import { memoryUsersRepo } from "../src/data/memory/users.js";

const DB_URL = process.env.TEST_DATABASE_URL;

const MIG_001 = fileURLToPath(new URL("../src/data/migrations/001_users_sessions.sql", import.meta.url));
const MIG_002 = fileURLToPath(new URL("../src/data/migrations/002_availability_bookings.sql", import.meta.url));

// Minimal copy of PLAN §4.1 users table, used when Area A's 001 file is absent.
const INLINE_USERS = `
CREATE TABLE users (
  id            INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  email         TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  name          TEXT NOT NULL,
  role          TEXT NOT NULL CHECK (role IN ('patient','doctor','admin')),
  specialty     TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX users_email_lower_uq ON users (lower(email));
`;

// ---------------------------------------------------------------- Postgres --

describe("pg bookings repo (integration)", { skip: DB_URL ? false : "TEST_DATABASE_URL not set" }, () => {
  const schema = `clinic_test_${process.pid}_${Math.random().toString(36).slice(2, 8)}`;
  let pool;
  let bookings;
  let availability;

  async function addUser(role, name, email) {
    const { rows } = await pool.query(
      `INSERT INTO users (email, password_hash, name, role, specialty)
       VALUES ($1, $2, $3, $4, $5) RETURNING id`,
      [email, "scrypt$deadbeef$deadbeef", name, role, role === "doctor" ? "GP" : null],
    );
    return rows[0].id;
  }

  async function addRule(doctorId, slot, spanMinutes = 30) {
    const dayOfWeek = slot.getUTCDay();
    const startMinute = slot.getUTCHours() * 60 + slot.getUTCMinutes();
    await pool.query(
      `INSERT INTO availability (doctor_id, day_of_week, start_minute, end_minute)
       VALUES ($1, $2, $3, $4)`,
      [doctorId, dayOfWeek, startMinute, startMinute + spanMinutes],
    );
    return { dayOfWeek, startMinute };
  }

  before(async () => {
    pool = new pg.Pool({
      connectionString: DB_URL,
      max: 12,
      options: `-c search_path=${schema}`,
    });
    await pool.query(`CREATE SCHEMA ${schema}`);
    if (existsSync(MIG_001)) {
      await pool.query(readFileSync(MIG_001, "utf8"));
    } else {
      await pool.query(INLINE_USERS);
    }
    await pool.query(readFileSync(MIG_002, "utf8"));
    bookings = pgBookingsRepo(pool);
    availability = pgAvailabilityRepo(pool);
  });

  after(async () => {
    if (!pool) return;
    try {
      await pool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    } catch {
      /* best effort */
    }
    await pool.end();
  });

  it("10 concurrent creates for the same doctor+slot → 1 fulfilled, 9 slot_taken", async () => {
    const doctorId = await addUser("doctor", "Dr Con", "con-doctor@x.io");
    const slot = new Date("2026-12-07T09:00:00.000Z");
    const { dayOfWeek, startMinute } = await addRule(doctorId, slot);

    const patients = [];
    for (let i = 0; i < 10; i++) patients.push(await addUser("patient", `Pat ${i}`, `con-p${i}@x.io`));

    const results = await Promise.allSettled(
      patients.map((patientId) =>
        bookings.create({ doctorId, patientId, slotStart: slot, dayOfWeek, startMinute }),
      ),
    );

    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected");
    assert.equal(fulfilled.length, 1, "exactly one booking wins");
    assert.equal(rejected.length, 9, "the other nine are rejected");
    for (const r of rejected) {
      assert.ok(r.reason instanceof ConflictError, "rejection is a ConflictError");
      assert.equal(r.reason.code, "slot_taken");
    }
    assert.equal(fulfilled[0].value.status, "booked");
  });

  it("after a cancel, a rebook of the same slot succeeds", async () => {
    const doctorId = await addUser("doctor", "Dr Cancel", "cancel-doctor@x.io");
    const slot = new Date("2026-12-08T10:00:00.000Z");
    const { dayOfWeek, startMinute } = await addRule(doctorId, slot);
    const p1 = await addUser("patient", "P One", "cancel-p1@x.io");
    const p2 = await addUser("patient", "P Two", "cancel-p2@x.io");

    const first = await bookings.create({ doctorId, patientId: p1, slotStart: slot, dayOfWeek, startMinute });
    assert.equal(first.status, "booked");
    assert.equal(first.end, new Date(slot.getTime() + 1_800_000).toISOString());

    const cancelled = await bookings.cancel(first.id, p1);
    assert.equal(cancelled.status, "cancelled");
    assert.ok(cancelled.cancelledAt);
    assert.equal(cancelled.cancelledBy, p1);

    const rebook = await bookings.create({ doctorId, patientId: p2, slotStart: slot, dayOfWeek, startMinute });
    assert.equal(rebook.status, "booked");
    assert.equal(rebook.patientId, p2);
  });

  it("the same patient booking two doctors at the same slot → patient_busy", async () => {
    const d1 = await addUser("doctor", "Dr A", "busy-d1@x.io");
    const d2 = await addUser("doctor", "Dr B", "busy-d2@x.io");
    const slot = new Date("2026-12-09T11:00:00.000Z");
    const r1 = await addRule(d1, slot);
    const r2 = await addRule(d2, slot);
    const patientId = await addUser("patient", "Busy Pat", "busy-p@x.io");

    await bookings.create({ doctorId: d1, patientId, slotStart: slot, dayOfWeek: r1.dayOfWeek, startMinute: r1.startMinute });
    await assert.rejects(
      bookings.create({ doctorId: d2, patientId, slotStart: slot, dayOfWeek: r2.dayOfWeek, startMinute: r2.startMinute }),
      (err) => err instanceof ConflictError && err.code === "patient_busy",
    );
  });

  it("a slot with no covering availability → outside_availability", async () => {
    const doctorId = await addUser("doctor", "Dr None", "none-doctor@x.io");
    const patientId = await addUser("patient", "P", "none-p@x.io");
    const slot = new Date("2026-12-10T09:00:00.000Z");
    const startMinute = slot.getUTCHours() * 60 + slot.getUTCMinutes();

    await assert.rejects(
      bookings.create({ doctorId, patientId, slotStart: slot, dayOfWeek: slot.getUTCDay(), startMinute }),
      (err) => err instanceof ValidationError && err.code === "outside_availability",
    );
  });

  it("a direct SQL INSERT at :15 violates the CHECK constraint (23514)", async () => {
    const doctorId = await addUser("doctor", "Dr Chk", "chk-doctor@x.io");
    const patientId = await addUser("patient", "P", "chk-p@x.io");
    await assert.rejects(
      pool.query(`INSERT INTO bookings (doctor_id, patient_id, slot_start) VALUES ($1, $2, $3)`, [
        doctorId,
        patientId,
        "2026-12-11T09:15:00.000Z",
      ]),
      (err) => err.code === "23514",
    );
  });

  it("pg_indexes shows the partial unique index with WHERE (status = 'booked'::text)", async () => {
    const { rows } = await pool.query(
      `SELECT indexname, indexdef FROM pg_indexes WHERE schemaname = $1 AND tablename = 'bookings'`,
      [schema],
    );
    const idx = rows.find((r) => r.indexname === "bookings_doctor_slot_active_uq");
    assert.ok(idx, "bookings_doctor_slot_active_uq exists");
    assert.match(idx.indexdef, /UNIQUE/);
    assert.match(idx.indexdef, /WHERE \(status = 'booked'::text\)/);
  });

  it("availability overlap is rejected and an adjacent range is allowed", async () => {
    const doctorId = await addUser("doctor", "Dr Avail", "avail-doctor@x.io");
    await availability.create({ doctorId, dayOfWeek: 1, startMinute: 540, endMinute: 600 }); // 09:00-10:00
    await assert.rejects(
      availability.create({ doctorId, dayOfWeek: 1, startMinute: 570, endMinute: 630 }),
      (err) => err instanceof ConflictError && err.code === "availability_overlap",
    );
    const adjacent = await availability.create({ doctorId, dayOfWeek: 1, startMinute: 600, endMinute: 660 });
    assert.equal(adjacent.startMinute, 600);
    assert.equal(adjacent.endMinute, 660);
  });
});

// ------------------------------------------------------------------ Memory --

test("memory bookings repo: 10 concurrent creates → exactly 1 winner", async () => {
  const users = memoryUsersRepo();
  const availability = memoryAvailabilityRepo();
  const bookings = memoryBookingsRepo();
  bookings.attach({ users, availability });

  const doctor = await users.create({ email: "m-doc@x.io", passwordHash: "x", name: "Dr Mem", role: "doctor" });
  const slot = new Date("2026-12-07T09:00:00.000Z");
  const dayOfWeek = slot.getUTCDay();
  const startMinute = slot.getUTCHours() * 60 + slot.getUTCMinutes();
  await availability.create({ doctorId: doctor.id, dayOfWeek, startMinute, endMinute: startMinute + 30 });

  const patients = [];
  for (let i = 0; i < 10; i++) {
    patients.push(await users.create({ email: `m-p${i}@x.io`, passwordHash: "x", name: `P${i}`, role: "patient" }));
  }

  const results = await Promise.allSettled(
    patients.map((p) =>
      bookings.create({ doctorId: doctor.id, patientId: p.id, slotStart: slot, dayOfWeek, startMinute }),
    ),
  );

  const fulfilled = results.filter((r) => r.status === "fulfilled");
  const rejected = results.filter((r) => r.status === "rejected");
  assert.equal(fulfilled.length, 1);
  assert.equal(rejected.length, 9);
  for (const r of rejected) {
    assert.ok(r.reason instanceof ConflictError);
    assert.equal(r.reason.code, "slot_taken");
  }
  const winner = fulfilled[0].value;
  assert.equal(winner.doctorName, "Dr Mem");
  assert.ok(winner.patientEmail.endsWith("@x.io"));
  assert.equal(winner.end, new Date(slot.getTime() + 1_800_000).toISOString());
});

test("memory bookings repo: outside_availability and patient_busy", async () => {
  const users = memoryUsersRepo();
  const availability = memoryAvailabilityRepo();
  const bookings = memoryBookingsRepo();
  bookings.attach({ users, availability });

  const d1 = await users.create({ email: "m2-d1@x.io", passwordHash: "x", name: "Dr One", role: "doctor" });
  const d2 = await users.create({ email: "m2-d2@x.io", passwordHash: "x", name: "Dr Two", role: "doctor" });
  const patient = await users.create({ email: "m2-p@x.io", passwordHash: "x", name: "Pat", role: "patient" });
  const slot = new Date("2026-12-08T10:00:00.000Z");
  const dayOfWeek = slot.getUTCDay();
  const startMinute = slot.getUTCHours() * 60 + slot.getUTCMinutes();

  await assert.rejects(
    bookings.create({ doctorId: d1.id, patientId: patient.id, slotStart: slot, dayOfWeek, startMinute }),
    (err) => err instanceof ValidationError && err.code === "outside_availability",
  );

  await availability.create({ doctorId: d1.id, dayOfWeek, startMinute, endMinute: startMinute + 30 });
  await availability.create({ doctorId: d2.id, dayOfWeek, startMinute, endMinute: startMinute + 30 });

  await bookings.create({ doctorId: d1.id, patientId: patient.id, slotStart: slot, dayOfWeek, startMinute });
  await assert.rejects(
    bookings.create({ doctorId: d2.id, patientId: patient.id, slotStart: slot, dayOfWeek, startMinute }),
    (err) => err instanceof ConflictError && err.code === "patient_busy",
  );
});
