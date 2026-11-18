// Area A — Postgres users/sessions data layer integration test.
//
// The suite is skipped unless TEST_DATABASE_URL is set. It runs entirely in an
// isolated, freshly-created schema (dropped in after()) so node --test's
// parallel files never collide with shared tables.
import { describe, test, before, after } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import pg from "pg";

import { migrate } from "../src/data/migrate.js";
import { pgUsersRepo } from "../src/data/pg/users.js";
import { pgSessionsRepo } from "../src/data/pg/sessions.js";
import { ConflictError } from "../src/errors.js";

const DB_URL = process.env.TEST_DATABASE_URL;

describe("pg users/sessions", { skip: !process.env.TEST_DATABASE_URL && "TEST_DATABASE_URL not set" }, () => {
  let schema;
  let adminPool;
  let pool;
  let firstRun;
  let users;
  let sessions;

  before(async () => {
    schema = `test_${process.pid}_${crypto.randomBytes(4).toString("hex")}`;
    adminPool = new pg.Pool({ connectionString: DB_URL });
    await adminPool.query(`CREATE SCHEMA "${schema}"`);
    pool = new pg.Pool({ connectionString: DB_URL, options: `-c search_path=${schema}` });
    users = pgUsersRepo(pool);
    sessions = pgSessionsRepo(pool);
    firstRun = await migrate(pool);
  });

  after(async () => {
    if (pool) await pool.end();
    if (adminPool) {
      try {
        await adminPool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      } finally {
        await adminPool.end();
      }
    }
  });

  // (1) first run applies 001 and creates the expected tables.
  test("first run applies 001 and creates users/sessions/schema_migrations", async () => {
    assert.ok(
      Array.isArray(firstRun) && firstRun.includes("001_users_sessions.sql"),
      `firstRun should include 001_users_sessions.sql, got ${JSON.stringify(firstRun)}`,
    );

    const { rows } = await pool.query(
      "SELECT table_name FROM information_schema.tables WHERE table_schema = $1",
      [schema],
    );
    const tables = rows.map((r) => r.table_name);
    for (const t of ["users", "sessions", "schema_migrations"]) {
      assert.ok(tables.includes(t), `table ${t} should exist, got ${JSON.stringify(tables)}`);
    }
  });

  // (2) a second run is a no-op and does not touch schema_migrations.
  test("re-running migrate returns [] and leaves schema_migrations unchanged", async () => {
    const beforeCount = await pool.query("SELECT count(*)::int AS n FROM schema_migrations");
    const again = await migrate(pool);
    assert.deepEqual(again, []);
    const afterCount = await pool.query("SELECT count(*)::int AS n FROM schema_migrations");
    assert.equal(afterCount.rows[0].n, beforeCount.rows[0].n);
  });

  // (3) the advisory lock serialises concurrent runners → both no-op.
  test("concurrent migrate calls both return []", async () => {
    const [a, b] = await Promise.all([migrate(pool), migrate(pool)]);
    assert.deepEqual(a, []);
    assert.deepEqual(b, []);
  });

  // (4) create() returns a public user; findByEmail is case-insensitive and keeps the hash.
  test("create returns a public user; findByEmail matches case-insensitively", async () => {
    const created = await users.create({
      email: "A@x.io",
      passwordHash: "scrypt$aa$bb",
      name: "Alice",
      role: "patient",
    });

    assert.equal(typeof created.id, "number");
    assert.ok(Number.isInteger(created.id), "id is an integer");
    assert.equal(created.email, "A@x.io");
    assert.equal(created.name, "Alice");
    assert.equal(created.role, "patient");
    assert.equal(created.specialty, null);
    assert.ok(!("passwordHash" in created), "create() must not expose passwordHash");
    assert.ok(!("password_hash" in created), "create() must not expose password_hash");

    const found = await users.findByEmail("a@X.IO");
    assert.ok(found, "findByEmail matches regardless of case");
    assert.equal(found.id, created.id);
    assert.equal(found.passwordHash, "scrypt$aa$bb");
    assert.ok(!("password_hash" in found), "findByEmail exposes passwordHash, not password_hash");
  });

  // (5) duplicate email in any case → ConflictError 409 email_taken.
  test("duplicate email (any case) rejects with 409 email_taken", async () => {
    // Test 4 already created A@x.io; guard so this test also stands alone.
    await users
      .create({ email: "a@X.io", passwordHash: "scrypt$aa$bb", name: "Alice", role: "patient" })
      .catch(() => {});

    await assert.rejects(
      users.create({ email: "a@X.io", passwordHash: "scrypt$cc$dd", name: "Alice Two", role: "patient" }),
      (err) => {
        assert.ok(err instanceof ConflictError, "rejection is a ConflictError");
        assert.equal(err.status, 409);
        assert.equal(err.code, "email_taken");
        return true;
      },
    );
  });

  // (6) findById never leaks the hash and is null-safe for bad ids.
  test("findById returns a public user; null for 'abc' and unknown ids", async () => {
    const u = await users.create({
      email: "findbyid@x.io",
      passwordHash: "scrypt$11$22",
      name: "Bob",
      role: "doctor",
      specialty: "Cardiology",
    });

    const found = await users.findById(u.id);
    assert.ok(found, "findById finds the user");
    assert.equal(found.id, u.id);
    assert.equal(found.specialty, "Cardiology");
    assert.ok(!("passwordHash" in found), "findById must not expose passwordHash");
    assert.ok(!("password_hash" in found), "findById must not expose password_hash");

    assert.equal(await users.findById("abc"), null);
    assert.equal(await users.findById(999999), null);
  });

  // (7) listByRole filters to the role and orders by id.
  test("listByRole returns only the requested role, ordered by id", async () => {
    const d1 = await users.create({ email: "list-doc1@x.io", passwordHash: "h", name: "Doc One", role: "doctor", specialty: "GP" });
    const d2 = await users.create({ email: "list-doc2@x.io", passwordHash: "h", name: "Doc Two", role: "doctor", specialty: "ENT" });
    await users.create({ email: "list-pat@x.io", passwordHash: "h", name: "Pat", role: "patient" });

    const docs = await users.listByRole("doctor");
    assert.ok(docs.length >= 2, "at least the two doctors just created");
    assert.ok(docs.every((d) => d.role === "doctor"), "every row is a doctor");

    const ids = docs.map((d) => d.id);
    assert.ok(ids.includes(d1.id) && ids.includes(d2.id));
    assert.deepEqual(ids, [...ids].sort((a, b) => a - b), "ordered by id ascending");
    assert.ok(docs.every((d) => !("passwordHash" in d) && !("password_hash" in d)), "no hashes exposed");
  });

  // (8) sessions lifecycle: create/findValid/delete/deleteExpired.
  test("sessions create, findValid, delete and deleteExpired", async () => {
    const u = await users.create({ email: "sess8@x.io", passwordHash: "h", name: "Sess User", role: "patient" });
    const now = Date.now();
    const future = new Date(now + 60_000);
    const past1 = new Date(now - 60_000);
    const past2 = new Date(now - 120_000);

    await sessions.create({ tokenHash: "tok-future", userId: u.id, expiresAt: future });
    await sessions.create({ tokenHash: "tok-past1", userId: u.id, expiresAt: past1 });
    await sessions.create({ tokenHash: "tok-past2", userId: u.id, expiresAt: past2 });

    const valid = await sessions.findValid("tok-future");
    assert.ok(valid, "a future session is valid");
    assert.equal(valid.userId, u.id);
    assert.ok(valid.expiresAt instanceof Date, "expiresAt is a Date");

    assert.equal(await sessions.findValid("tok-future", new Date(future.getTime() + 1000)), null);

    assert.equal(await sessions.delete("tok-future"), true);
    assert.equal(await sessions.delete("tok-future"), false);
    assert.equal(await sessions.findValid("tok-future"), null);

    // Keep one future session around; the two past ones must be swept.
    await sessions.create({ tokenHash: "tok-future2", userId: u.id, expiresAt: new Date(now + 120_000) });
    assert.equal(await sessions.deleteExpired(), 2);
    assert.equal(await sessions.findValid("tok-past1"), null);
    assert.equal(await sessions.findValid("tok-past2"), null);
    assert.ok(await sessions.findValid("tok-future2"), "the future session survives");
  });

  // (9) deleting a user cascades to their sessions.
  test("deleting a user cascades to their sessions", async () => {
    const u = await users.create({ email: "cascade@x.io", passwordHash: "h", name: "Cascade", role: "patient" });
    await sessions.create({ tokenHash: "cascade-tok", userId: u.id, expiresAt: new Date(Date.now() + 60_000) });
    assert.ok(await sessions.findValid("cascade-tok"), "session exists before delete");

    await pool.query("DELETE FROM users WHERE id = $1", [u.id]);

    assert.equal(await sessions.findValid("cascade-tok"), null);
    const { rows } = await pool.query("SELECT 1 FROM sessions WHERE token_hash = $1", ["cascade-tok"]);
    assert.equal(rows.length, 0, "cascade removed the session row");
  });
});
