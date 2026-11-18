import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { startApp, createUser, loginAs, client } from "./helpers.js";
import { loadConfig } from "../src/config.js";

function testConfig() {
  return { ...loadConfig({}), clinicOffsetMinutes: 0, sessionTtlHours: 1, cookieSecure: false };
}

/** The next Monday at least 2 days ahead (UTC, clinic offset is 0). */
function nextMonday() {
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  d.setUTCDate(d.getUTCDate() + 2);
  while (d.getUTCDay() !== 1) d.setUTCDate(d.getUTCDate() + 1);
  return d;
}

const pad = (n) => String(n).padStart(2, "0");
const dateStr = (d) => d.toISOString().slice(0, 10);
const at = (d, h, m) => `${dateStr(d)}T${pad(h)}:${pad(m)}:00.000Z`;

/** Sets up an app with one doctor (Monday 09:00–12:00) and one patient. */
async function setupEnv({ audit } = {}) {
  const app = await startApp({ config: testConfig(), repos: audit ? { audit } : undefined });
  const repos = app.repos;
  const monday = nextMonday();
  const doctor = await createUser(repos, { role: "doctor", name: "Dr Dee", specialty: "GP" });
  await repos.availability.create({ doctorId: doctor.id, dayOfWeek: 1, startMinute: 540, endMinute: 720 });
  const patient = await createUser(repos, { role: "patient", name: "Pat One" });
  const patientClient = await loginAs(repos, app.url, patient);
  const doctorClient = await loginAs(repos, app.url, doctor);
  return { ...app, repos, monday, doctor, patient, patientClient, doctorClient };
}

test("bookings: patient books a free slot → 201, slot disappears from /slots", async () => {
  const env = await setupEnv();
  try {
    const slot0 = at(env.monday, 9, 0);
    const res = await env.patientClient.post("/api/bookings", { doctorId: env.doctor.id, start: slot0 });
    assert.equal(res.status, 201);
    assert.equal(res.body.booking.status, "booked");
    assert.equal(res.body.booking.doctorId, env.doctor.id);
    assert.equal(res.body.booking.patientId, env.patient.id);
    assert.equal(res.body.booking.start, slot0);
    assert.equal(res.body.booking.end, at(env.monday, 9, 30));

    const slots = await env.patientClient.get(`/api/doctors/${env.doctor.id}/slots?from=${dateStr(env.monday)}&days=1`);
    assert.equal(slots.status, 200);
    assert.ok(!slots.body.slots.some((s) => s.start === slot0), "booked slot must be excluded");
    assert.ok(slots.body.slots.some((s) => s.start === at(env.monday, 9, 30)));
  } finally {
    await env.close();
  }
});

test("bookings: Promise.all race for one slot → one 201, one 409 slot_taken", async () => {
  const env = await setupEnv();
  try {
    const slot0 = at(env.monday, 9, 0);
    const other = await createUser(env.repos, { role: "patient", name: "Pat Two" });
    const otherClient = await loginAs(env.repos, env.url, other);

    const [a, b] = await Promise.all([
      env.patientClient.post("/api/bookings", { doctorId: env.doctor.id, start: slot0 }),
      otherClient.post("/api/bookings", { doctorId: env.doctor.id, start: slot0 }),
    ]);
    const statuses = [a.status, b.status].sort((x, y) => x - y);
    assert.deepEqual(statuses, [201, 409]);
    const conflict = a.status === 409 ? a : b;
    assert.equal(conflict.body.error.code, "slot_taken");
  } finally {
    await env.close();
  }
});

test("bookings: same patient, same time, another doctor → 409 patient_busy", async () => {
  const env = await setupEnv();
  try {
    const doctor2 = await createUser(env.repos, { role: "doctor", name: "Dr Two" });
    await env.repos.availability.create({ doctorId: doctor2.id, dayOfWeek: 1, startMinute: 540, endMinute: 720 });
    const slot0 = at(env.monday, 9, 0);

    const first = await env.patientClient.post("/api/bookings", { doctorId: env.doctor.id, start: slot0 });
    assert.equal(first.status, 201);

    const second = await env.patientClient.post("/api/bookings", { doctorId: doctor2.id, start: slot0 });
    assert.equal(second.status, 409);
    assert.equal(second.body.error.code, "patient_busy");
  } finally {
    await env.close();
  }
});

test("bookings: misaligned / outside / past → 400 with the exact codes", async () => {
  const env = await setupEnv();
  try {
    let res = await env.patientClient.post("/api/bookings", { doctorId: env.doctor.id, start: at(env.monday, 9, 15) });
    assert.equal(res.status, 400);
    assert.equal(res.body.error.code, "misaligned_slot");

    res = await env.patientClient.post("/api/bookings", { doctorId: env.doctor.id, start: at(env.monday, 13, 0) });
    assert.equal(res.status, 400);
    assert.equal(res.body.error.code, "outside_availability");

    const alignedPast = new Date(Math.floor(Date.now() / 1_800_000) * 1_800_000 - 1_800_000);
    res = await env.patientClient.post("/api/bookings", { doctorId: env.doctor.id, start: alignedPast.toISOString() });
    assert.equal(res.status, 400);
    assert.equal(res.body.error.code, "slot_in_past");
  } finally {
    await env.close();
  }
});

test("bookings: doctor or admin POST /api/bookings → 403", async () => {
  const env = await setupEnv();
  try {
    const admin = await createUser(env.repos, { role: "admin" });
    const adminClient = await loginAs(env.repos, env.url, admin);
    const slot0 = at(env.monday, 9, 0);

    let res = await env.doctorClient.post("/api/bookings", { doctorId: env.doctor.id, start: slot0 });
    assert.equal(res.status, 403);

    res = await adminClient.post("/api/bookings", { doctorId: env.doctor.id, start: slot0 });
    assert.equal(res.status, 403);
  } finally {
    await env.close();
  }
});

test("bookings: cancel by owner → 200, another patient → 404, twice → 409, rebook → 201", async () => {
  const env = await setupEnv();
  try {
    const slot0 = at(env.monday, 9, 0);
    const booked = await env.patientClient.post("/api/bookings", { doctorId: env.doctor.id, start: slot0 });
    const id = booked.body.booking.id;

    const stranger = await createUser(env.repos, { role: "patient", name: "Stranger" });
    const strangerClient = await loginAs(env.repos, env.url, stranger);
    let res = await strangerClient.post(`/api/bookings/${id}/cancel`, {});
    assert.equal(res.status, 404);

    res = await env.patientClient.post(`/api/bookings/${id}/cancel`, {});
    assert.equal(res.status, 200);
    assert.equal(res.body.booking.status, "cancelled");

    res = await env.patientClient.post(`/api/bookings/${id}/cancel`, {});
    assert.equal(res.status, 409);
    assert.equal(res.body.error.code, "already_cancelled");

    res = await env.patientClient.post("/api/bookings", { doctorId: env.doctor.id, start: slot0 });
    assert.equal(res.status, 201);
  } finally {
    await env.close();
  }
});

test("bookings: doctor sees their booking in /api/doctor/bookings", async () => {
  const env = await setupEnv();
  try {
    const slot0 = at(env.monday, 9, 0);
    const booked = await env.patientClient.post("/api/bookings", { doctorId: env.doctor.id, start: slot0 });
    assert.equal(booked.status, 201);

    const res = await env.doctorClient.get("/api/doctor/bookings");
    assert.equal(res.status, 200);
    assert.ok(res.body.bookings.some((b) => b.id === booked.body.booking.id));
    const found = res.body.bookings.find((b) => b.id === booked.body.booking.id);
    assert.equal(found.patientId, env.patient.id);
    assert.equal(found.patientName, "Pat One");
  } finally {
    await env.close();
  }
});

test("bookings: audit holds exactly 1 created + 1 cancelled with the actor role", async () => {
  const env = await setupEnv();
  try {
    const slot0 = at(env.monday, 9, 0);
    const booked = await env.patientClient.post("/api/bookings", { doctorId: env.doctor.id, start: slot0 });
    const id = booked.body.booking.id;
    const cancelled = await env.patientClient.post(`/api/bookings/${id}/cancel`, {});
    assert.equal(cancelled.status, 200);

    const entries = await env.repos.audit.list({ bookingId: id });
    assert.equal(entries.length, 2);
    const actions = entries.map((e) => e.action).sort();
    assert.deepEqual(actions, ["booking.cancelled", "booking.created"]);
    for (const e of entries) {
      assert.equal(e.actor.role, "patient");
      assert.equal(e.actor.id, env.patient.id);
      assert.equal(e.bookingId, id);
      assert.equal(e.doctorId, env.doctor.id);
      assert.equal(e.patientId, env.patient.id);
    }
    const created = entries.find((e) => e.action === "booking.created");
    const canc = entries.find((e) => e.action === "booking.cancelled");
    assert.equal(created.before, null);
    assert.equal(created.after.status, "booked");
    assert.equal(canc.before.status, "booked");
    assert.equal(canc.after.status, "cancelled");
  } finally {
    await env.close();
  }
});

test("bookings: failing audit repo → still 201 and console.error gets AUDIT_WRITE_FAILED", async () => {
  const failingAudit = {
    async record() {
      throw new Error("audit store down");
    },
    async list() {
      return [];
    },
  };
  const env = await setupEnv({ audit: failingAudit });
  const spy = mock.method(console, "error", () => {});
  try {
    const slot0 = at(env.monday, 9, 0);
    const res = await env.patientClient.post("/api/bookings", { doctorId: env.doctor.id, start: slot0 });
    assert.equal(res.status, 201);
    const hit = spy.mock.calls.some((c) => c.arguments[0] === "AUDIT_WRITE_FAILED");
    assert.ok(hit, "console.error must receive AUDIT_WRITE_FAILED");
  } finally {
    spy.mock.restore();
    await env.close();
  }
});

test("bookings: unknown doctor → 404 doctor_not_found", async () => {
  const env = await setupEnv();
  try {
    let res = await env.patientClient.post("/api/bookings", { doctorId: 999999, start: at(env.monday, 9, 0) });
    assert.equal(res.status, 404);
    assert.equal(res.body.error.code, "doctor_not_found");

    res = await env.patientClient.get("/api/doctors/999999/slots");
    assert.equal(res.status, 404);
    assert.equal(res.body.error.code, "doctor_not_found");
  } finally {
    await env.close();
  }
});

test("bookings: anonymous callers get 401", async () => {
  const env = await setupEnv();
  try {
    const anon = client(env.url);
    let res = await anon.get("/api/doctors");
    assert.equal(res.status, 401);

    res = await anon.post("/api/bookings", { doctorId: env.doctor.id, start: at(env.monday, 9, 0) });
    assert.equal(res.status, 401);

    res = await anon.get("/api/bookings/mine");
    assert.equal(res.status, 401);

    res = await anon.get("/api/doctor/availability");
    assert.equal(res.status, 401);
  } finally {
    await env.close();
  }
});