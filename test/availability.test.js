import { test } from "node:test";
import assert from "node:assert/strict";
import { startApp, createUser, loginAs } from "./helpers.js";
import { loadConfig } from "../src/config.js";

/** Test config: clinic offset 0 (clinic time == UTC), memory repos. */
function testConfig() {
  return { ...loadConfig({}), clinicOffsetMinutes: 0, sessionTtlHours: 1, cookieSecure: false };
}

test("availability: doctor CRUD → 201/200/204", async () => {
  const { url, repos, close } = await startApp({ config: testConfig() });
  try {
    const doctor = await createUser(repos, { role: "doctor", name: "Dr Dee" });
    const doc = await loginAs(repos, url, doctor);

    let res = await doc.get("/api/doctor/availability");
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.rules, []);

    res = await doc.post("/api/doctor/availability", { dayOfWeek: 1, startTime: "09:00", endTime: "12:00" });
    assert.equal(res.status, 201);
    assert.equal(res.body.rule.dayOfWeek, 1);
    assert.equal(res.body.rule.startTime, "09:00");
    assert.equal(res.body.rule.endTime, "12:00");
    const ruleId = res.body.rule.id;

    res = await doc.get("/api/doctor/availability");
    assert.equal(res.status, 200);
    assert.equal(res.body.rules.length, 1);

    res = await doc.put(`/api/doctor/availability/${ruleId}`, { dayOfWeek: 1, startTime: "08:00", endTime: "12:00" });
    assert.equal(res.status, 200);
    assert.equal(res.body.rule.startTime, "08:00");

    res = await doc.del(`/api/doctor/availability/${ruleId}`);
    assert.equal(res.status, 204);

    res = await doc.get("/api/doctor/availability");
    assert.equal(res.body.rules.length, 0);
  } finally {
    await close();
  }
});

test("availability: misaligned time → 400, start >= end → 400", async () => {
  const { url, repos, close } = await startApp({ config: testConfig() });
  try {
    const doctor = await createUser(repos, { role: "doctor" });
    const doc = await loginAs(repos, url, doctor);

    let res = await doc.post("/api/doctor/availability", { dayOfWeek: 1, startTime: "09:15", endTime: "12:00" });
    assert.equal(res.status, 400);
    assert.equal(res.body.error.code, "validation");

    res = await doc.post("/api/doctor/availability", { dayOfWeek: 1, startTime: "12:00", endTime: "09:00" });
    assert.equal(res.status, 400);
    assert.equal(res.body.error.code, "validation");

    res = await doc.post("/api/doctor/availability", { dayOfWeek: 1, startTime: "09:00", endTime: "09:00" });
    assert.equal(res.status, 400);

    res = await doc.post("/api/doctor/availability", { dayOfWeek: 9, startTime: "09:00", endTime: "12:00" });
    assert.equal(res.status, 400);
  } finally {
    await close();
  }
});

test("availability: overlap → 409, adjacent range → 201", async () => {
  const { url, repos, close } = await startApp({ config: testConfig() });
  try {
    const doctor = await createUser(repos, { role: "doctor" });
    const doc = await loginAs(repos, url, doctor);

    let res = await doc.post("/api/doctor/availability", { dayOfWeek: 1, startTime: "09:00", endTime: "10:00" });
    assert.equal(res.status, 201);

    res = await doc.post("/api/doctor/availability", { dayOfWeek: 1, startTime: "09:30", endTime: "10:30" });
    assert.equal(res.status, 409);
    assert.equal(res.body.error.code, "availability_overlap");

    res = await doc.post("/api/doctor/availability", { dayOfWeek: 1, startTime: "10:00", endTime: "11:00" });
    assert.equal(res.status, 201);

    res = await doc.post("/api/doctor/availability", { dayOfWeek: 2, startTime: "09:00", endTime: "10:00" });
    assert.equal(res.status, 201);
  } finally {
    await close();
  }
});

test("availability: another doctor's rule → 404 on edit/delete", async () => {
  const { url, repos, close } = await startApp({ config: testConfig() });
  try {
    const docA = await createUser(repos, { role: "doctor", email: "doc-a@clinic.test" });
    const docB = await createUser(repos, { role: "doctor", email: "doc-b@clinic.test" });
    const a = await loginAs(repos, url, docA);
    const b = await loginAs(repos, url, docB);

    const res = await a.post("/api/doctor/availability", { dayOfWeek: 1, startTime: "09:00", endTime: "10:00" });
    assert.equal(res.status, 201);
    const ruleId = res.body.rule.id;

    let other = await b.put(`/api/doctor/availability/${ruleId}`, { dayOfWeek: 1, startTime: "08:00", endTime: "09:00" });
    assert.equal(other.status, 404);

    other = await b.del(`/api/doctor/availability/${ruleId}`);
    assert.equal(other.status, 404);

    // The owner's rule is untouched.
    const list = await a.get("/api/doctor/availability");
    assert.equal(list.body.rules.length, 1);
  } finally {
    await close();
  }
});

test("availability: patient → 403 on doctor routes", async () => {
  const { url, repos, close } = await startApp({ config: testConfig() });
  try {
    const patient = await createUser(repos, { role: "patient" });
    const pat = await loginAs(repos, url, patient);

    let res = await pat.get("/api/doctor/availability");
    assert.equal(res.status, 403);

    res = await pat.post("/api/doctor/availability", { dayOfWeek: 1, startTime: "09:00", endTime: "10:00" });
    assert.equal(res.status, 403);

    res = await pat.get("/api/doctor/bookings");
    assert.equal(res.status, 403);
  } finally {
    await close();
  }
});