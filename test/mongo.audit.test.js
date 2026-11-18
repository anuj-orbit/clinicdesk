import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { memoryAuditRepo } from "../src/data/memory/audit.js";
import { mongoAuditRepo } from "../src/data/mongo/audit.js";
import { MongoClient } from "mongodb";

describe("memory audit repo", () => {
  const repo = memoryAuditRepo();

  it("records 3 events for bookingId 42 and 1 for another booking", async () => {
    const baseTime = new Date("2026-01-01T10:00:00Z");
    await repo.record({
      action: "booking.created",
      bookingId: 42,
      at: new Date(baseTime.getTime()),
      actor: { id: 1, role: "patient", email: "a@b.com" },
      doctorId: 10,
      patientId: 1,
      slotStart: "2026-01-01T10:00:00Z",
      before: null,
      after: { status: "confirmed" },
      meta: { ip: "1.2.3.4", userAgent: "test" },
    });
    await repo.record({
      action: "booking.cancelled",
      bookingId: 42,
      at: new Date(baseTime.getTime() + 1000),
      actor: { id: 1, role: "patient", email: "a@b.com" },
      doctorId: 10,
      patientId: 1,
      slotStart: "2026-01-01T10:00:00Z",
      before: { status: "confirmed" },
      after: { status: "cancelled" },
      meta: { ip: "1.2.3.4", userAgent: "test" },
    });
    await repo.record({
      action: "booking.created",
      bookingId: 42,
      at: new Date(baseTime.getTime() + 2000),
      actor: { id: 2, role: "doctor", email: "doc@b.com" },
      doctorId: 10,
      patientId: 1,
      slotStart: "2026-01-01T11:00:00Z",
      before: null,
      after: { status: "confirmed" },
      meta: { ip: "5.6.7.8", userAgent: "test" },
    });
    await repo.record({
      action: "booking.created",
      bookingId: 99,
      at: new Date(baseTime.getTime() + 3000),
      actor: { id: 3, role: "patient", email: "c@b.com" },
      doctorId: 20,
      patientId: 3,
      slotStart: "2026-01-01T12:00:00Z",
      before: null,
      after: { status: "confirmed" },
      meta: { ip: "9.10.11.12", userAgent: "test" },
    });
  });

  it("list({bookingId:42}) returns 3 newest-first with string ids and ISO string dates, no _id", async () => {
    const results = await repo.list({ bookingId: 42 });
    assert.equal(results.length, 3);
    for (const r of results) {
      assert.equal(typeof r.id, "string");
      assert.equal(r.id.length > 0, true);
      assert.ok(!("_id" in r));
      assert.equal(typeof r.at, "string");
      assert.ok(r.at.includes("T"));
      assert.ok(!(r.at instanceof Date));
      if (r.slotStart) {
        assert.equal(typeof r.slotStart, "string");
        assert.ok(r.slotStart.includes("T"));
      }
    }
    // newest first
    assert.ok(results[0].at >= results[1].at);
    assert.ok(results[1].at >= results[2].at);
  });

  it("limit clamps: limit:1 -> 1; limit:10000 -> <=500", async () => {
    const r1 = await repo.list({ bookingId: 42, limit: 1 });
    assert.equal(r1.length, 1);
    const r500 = await repo.list({ bookingId: 42, limit: 10000 });
    assert.ok(r500.length <= 500);
  });

  it("bookingId as string '42' works", async () => {
    const results = await repo.list({ bookingId: "42" });
    assert.equal(results.length, 3);
  });

  it("returned entries are copies (mutating doesn't affect next list)", async () => {
    const results = await repo.list({ bookingId: 42 });
    const firstId = results[0].id;
    results[0].action = "mutated";
    results[0].actor = { id: 999 };
    const again = await repo.list({ bookingId: 42 });
    assert.equal(again[0].id, firstId);
    assert.notEqual(again[0].action, "mutated");
    assert.notEqual(again[0].actor.id, 999);
  });
});

const uri = process.env.TEST_MONGODB_URI;

describe("mongo audit repo", { skip: !uri && "TEST_MONGODB_URI not set" }, () => {
  let client;
  let repo;
  const collName = `audit_test_${process.pid}_${Math.random().toString(16).slice(2)}`;

  before(async () => {
    client = new MongoClient(uri, { serverSelectionTimeoutMS: 5000 });
    await client.connect();
    repo = mongoAuditRepo(async () => client.db(), collName);
  });

  after(async () => {
    const db = client.db();
    await db.collection(collName).drop();
    await client.close();
  });

  it("records 3 events for bookingId 42 and 1 for bookingId 7", async () => {
    const baseTime = new Date("2026-01-01T10:00:00Z");
    await repo.record({
      action: "booking.created",
      bookingId: 42,
      at: new Date(baseTime.getTime()),
      actor: { id: 1, role: "patient", email: "a@b.com" },
      doctorId: 10,
      patientId: 1,
      slotStart: "2026-01-01T10:00:00Z",
      before: null,
      after: { status: "confirmed" },
      meta: { ip: "1.2.3.4", userAgent: "test" },
    });
    await repo.record({
      action: "booking.cancelled",
      bookingId: 42,
      at: new Date(baseTime.getTime() + 1000),
      actor: { id: 1, role: "patient", email: "a@b.com" },
      doctorId: 10,
      patientId: 1,
      slotStart: "2026-01-01T10:00:00Z",
      before: { status: "confirmed" },
      after: { status: "cancelled" },
      meta: { ip: "1.2.3.4", userAgent: "test" },
    });
    await repo.record({
      action: "booking.created",
      bookingId: 42,
      at: new Date(baseTime.getTime() + 2000),
      actor: { id: 2, role: "doctor", email: "doc@b.com" },
      doctorId: 10,
      patientId: 1,
      slotStart: "2026-01-01T11:00:00Z",
      before: null,
      after: { status: "confirmed" },
      meta: { ip: "5.6.7.8", userAgent: "test" },
    });
    await repo.record({
      action: "booking.created",
      bookingId: 7,
      at: new Date(baseTime.getTime() + 3000),
      actor: { id: 3, role: "patient", email: "c@b.com" },
      doctorId: 20,
      patientId: 3,
      slotStart: "2026-01-01T12:00:00Z",
      before: null,
      after: { status: "confirmed" },
      meta: { ip: "9.10.11.12", userAgent: "test" },
    });
  });

  it("list({bookingId:42}) returns exactly 3 newest-first, id is 24-char hex, no _id, at is ISO string", async () => {
    const results = await repo.list({ bookingId: 42 });
    assert.equal(results.length, 3);
    for (const r of results) {
      assert.equal(r.id.length, 24);
      assert.match(r.id, /^[0-9a-f]{24}$/);
      assert.ok(!("_id" in r));
      assert.equal(typeof r.at, "string");
      assert.ok(r.at.includes("T"));
      assert.ok(!(r.at instanceof Date));
      if (r.slotStart) {
        assert.equal(typeof r.slotStart, "string");
        assert.ok(r.slotStart.includes("T"));
      }
    }
    // newest first
    assert.ok(results[0].at >= results[1].at);
    assert.ok(results[1].at >= results[2].at);
  });

  it("list() without filter returns 4", async () => {
    const results = await repo.list({});
    assert.equal(results.length, 4);
  });

  it("indexes exist ({bookingId:1,at:-1} and {at:-1})", async () => {
    const db = client.db();
    const indexes = await db.collection(collName).indexes();
    const keys = indexes.map(i => i.key);
    const hasBookingIdAt = keys.some(k => k.bookingId === 1 && k.at === -1);
    const hasAt = keys.some(k => k.at === -1 && !k.bookingId);
    assert.ok(hasBookingIdAt, "index {bookingId:1,at:-1} missing");
    assert.ok(hasAt, "index {at:-1} missing");
  });
});
describe("mongo audit repo (no server needed)", () => {
  it("is lazy: constructing the repo does not touch Mongo", async () => {
    let calls = 0;
    mongoAuditRepo(async () => {
      calls += 1;
      throw new Error("should not be called");
    });
    await new Promise((r) => setImmediate(r));
    assert.equal(calls, 0);
  });

  it("retries the connection after a failed first use", async () => {
    let calls = 0;
    const repo = mongoAuditRepo(async () => {
      calls += 1;
      throw new Error("mongo down");
    });
    await assert.rejects(() => repo.list({}), /mongo down/);
    await assert.rejects(() => repo.record({ action: "booking.created", bookingId: 1 }), /mongo down/);
    assert.equal(calls, 2);
  });

  it("each repo instance uses its own collection", async () => {
    const used = [];
    const fakeDb = {
      collection(name) {
        used.push(name);
        return {
          createIndexes: async () => [],
          find: () => ({ sort: () => ({ limit: () => ({ toArray: async () => [] }) }) }),
        };
      },
    };
    await mongoAuditRepo(async () => fakeDb, "coll_a").list({});
    await mongoAuditRepo(async () => fakeDb, "coll_b").list({});
    assert.deepEqual(used, ["coll_a", "coll_b"]);
  });
});

describe("audit repo limit handling", () => {
  it("memory repo: invalid limit falls back to the default instead of returning nothing", async () => {
    const repo = memoryAuditRepo();
    await repo.record({ action: "booking.created", bookingId: 5, at: new Date() });
    assert.equal((await repo.list({ limit: "abc" })).length, 1);
    assert.equal((await repo.list({ limit: 0 })).length, 1);
    assert.deepEqual(await repo.list({ bookingId: "nope" }), []);
  });
});
