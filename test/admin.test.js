import { test } from "node:test";
import assert from "node:assert";
import { startApp } from "./helpers.js";
import { hashToken } from "../src/auth/session.js";

function makeStubRepos() {
  const bookings = [];
  const audit = [];
  const calls = { listAll: [], list: [] };

  return {
    calls,
    bookings: {
      // Intentionally unsorted and unlimited: the route must sort and cap.
      async listAll(args) {
        calls.listAll.push(args);
        let filtered = [...bookings];
        if (args.status) filtered = filtered.filter((b) => b.status === args.status);
        if (args.doctorId !== undefined) filtered = filtered.filter((b) => b.doctorId === args.doctorId);
        if (args.from) filtered = filtered.filter((b) => new Date(b.start) >= args.from);
        if (args.to) filtered = filtered.filter((b) => new Date(b.start) <= args.to);
        return filtered;
      },
      async create(b) {
        bookings.push(b);
        return b;
      },
    },
    audit: {
      async list(args) {
        calls.list.push(args);
        let filtered = [...audit];
        if (args.bookingId !== undefined) filtered = filtered.filter((e) => e.bookingId === args.bookingId);
        return filtered;
      },
      async record(event) {
        audit.push(event);
        return event;
      },
    },
  };
}

function makeBooking(overrides) {
  return {
    doctorId: 1,
    doctorName: "Dr A",
    patientId: 2,
    patientName: "Pat",
    patientEmail: "pat@x",
    start: "2026-11-20T09:00:00.000Z",
    end: "2026-11-20T09:30:00.000Z",
    status: "booked",
    createdAt: "2026-11-10T09:00:00.000Z",
    cancelledAt: null,
    cancelledBy: null,
    ...overrides,
  };
}

function makeAudit(overrides) {
  return {
    action: "booking.created",
    bookingId: 1,
    at: new Date("2026-11-20T09:00:00.000Z"),
    actor: { id: 1, role: "patient", email: "p@x" },
    doctorId: 1,
    patientId: 1,
    slotStart: new Date("2026-11-20T09:00:00.000Z"),
    before: null,
    after: { status: "booked" },
    meta: { ip: "1.2.3.4", userAgent: "test" },
    ...overrides,
  };
}

/** Starts the app with stub bookings/audit repos; returns a rich context. */
async function boot() {
  const stub = makeStubRepos();
  const ctx = await startApp({ repos: stub });
  const repos = ctx.repos; // merged: memory users/sessions + stub bookings/audit

  ctx.loginAs = async (role, email) => {
    const user = await repos.users.create({ email, passwordHash: "hash", name: role, role });
    const token = `tok_${email}`;
    await repos.sessions.create({
      tokenHash: hashToken(token),
      userId: user.id,
      expiresAt: new Date(Date.now() + 60_000),
    });
    return `sid=${token}`;
  };

  return ctx;
}

async function withApp(fn) {
  const ctx = await boot();
  try {
    await fn(ctx);
  } finally {
    await ctx.close();
  }
}

test("anon gets 401 on both admin endpoints", async () => {
  await withApp(async ({ url }) => {
    assert.equal((await fetch(`${url}/api/admin/bookings`)).status, 401);
    assert.equal((await fetch(`${url}/api/admin/audit`)).status, 401);
  });
});

test("patient and doctor get 403 on both admin endpoints", async () => {
  await withApp(async ({ url, loginAs }) => {
    const patientCookie = await loginAs("patient", "patient@test");
    const doctorCookie = await loginAs("doctor", "doctor@test");

    for (const cookie of [patientCookie, doctorCookie]) {
      assert.equal((await fetch(`${url}/api/admin/bookings`, { headers: { cookie } })).status, 403);
      assert.equal((await fetch(`${url}/api/admin/audit`, { headers: { cookie } })).status, 403);
    }
  });
});

test("admin gets {bookings} sorted by start descending", async () => {
  await withApp(async ({ url, repos, loginAs }) => {
    const cookie = await loginAs("admin", "admin@test");

    await repos.bookings.create(makeBooking({ start: "2026-11-18T09:00:00.000Z" }));
    await repos.bookings.create(makeBooking({ start: "2026-11-22T09:00:00.000Z" }));
    await repos.bookings.create(makeBooking({ start: "2026-11-20T09:00:00.000Z" }));

    const res = await fetch(`${url}/api/admin/bookings`, { headers: { cookie } });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.ok(Array.isArray(body.bookings));
    assert.equal(body.bookings.length, 3);
    assert.deepEqual(
      body.bookings.map((b) => b.start),
      ["2026-11-22T09:00:00.000Z", "2026-11-20T09:00:00.000Z", "2026-11-18T09:00:00.000Z"],
    );
  });
});

test("status and doctorId filters are passed through and applied", async () => {
  await withApp(async ({ url, repos, loginAs }) => {
    const cookie = await loginAs("admin", "admin@test");

    await repos.bookings.create(makeBooking({ status: "booked", doctorId: 1 }));
    await repos.bookings.create(makeBooking({ status: "cancelled", doctorId: 1 }));
    await repos.bookings.create(makeBooking({ status: "cancelled", doctorId: 2 }));

    const res = await fetch(`${url}/api/admin/bookings?status=cancelled&doctorId=1`, {
      headers: { cookie },
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.bookings.length, 1);
    assert.equal(body.bookings[0].status, "cancelled");
    assert.equal(body.bookings[0].doctorId, 1);

    const last = repos.calls.listAll.at(-1);
    assert.equal(last.status, "cancelled");
    assert.equal(last.doctorId, 1);
  });
});

test("from/to are parsed to Date and passed through", async () => {
  await withApp(async ({ url, repos, loginAs }) => {
    const cookie = await loginAs("admin", "admin@test");

    const res = await fetch(`${url}/api/admin/bookings?from=2026-11-15&to=2026-11-25`, {
      headers: { cookie },
    });
    assert.equal(res.status, 200);
    const last = repos.calls.listAll.at(-1);
    assert.ok(last.from instanceof Date);
    assert.ok(last.to instanceof Date);
    assert.equal(last.from.toISOString(), new Date("2026-11-15").toISOString());
  });
});

test("limit defaults to 200 and is capped at 500", async () => {
  await withApp(async ({ url, repos, loginAs }) => {
    const cookie = await loginAs("admin", "admin@test");

    await fetch(`${url}/api/admin/bookings`, { headers: { cookie } });
    assert.equal(repos.calls.listAll.at(-1).limit, 200);

    await fetch(`${url}/api/admin/bookings?limit=50`, { headers: { cookie } });
    assert.equal(repos.calls.listAll.at(-1).limit, 50);

    await fetch(`${url}/api/admin/bookings?limit=600`, { headers: { cookie } });
    assert.equal(repos.calls.listAll.at(-1).limit, 500);
  });
});

test("bad status/ints/dates give 400 validation", async () => {
  await withApp(async ({ url, loginAs }) => {
    const cookie = await loginAs("admin", "admin@test");

    for (const qs of [
      "status=weird",
      "doctorId=abc",
      "doctorId=1.5",
      "from=notadate",
      "to=nope",
      "limit=abc",
      "limit=0",
    ]) {
      const res = await fetch(`${url}/api/admin/bookings?${qs}`, { headers: { cookie } });
      assert.equal(res.status, 400, qs);
      assert.equal((await res.json()).error.code, "validation", qs);
    }

    const auditRes = await fetch(`${url}/api/admin/audit?bookingId=abc`, { headers: { cookie } });
    assert.equal(auditRes.status, 400);
    assert.equal((await auditRes.json()).error.code, "validation");
  });
});

test("audit: bookingId passed as number, {entries} sorted by at desc", async () => {
  await withApp(async ({ url, repos, loginAs }) => {
    const cookie = await loginAs("admin", "admin@test");

    await repos.audit.record(
      makeAudit({ bookingId: 5, action: "booking.created", at: new Date("2026-11-20T09:00:00.000Z") }),
    );
    await repos.audit.record(
      makeAudit({ bookingId: 5, action: "booking.cancelled", at: new Date("2026-11-20T10:00:00.000Z") }),
    );
    await repos.audit.record(
      makeAudit({ bookingId: 6, action: "booking.created", at: new Date("2026-11-20T11:00:00.000Z") }),
    );

    const res = await fetch(`${url}/api/admin/audit?bookingId=5`, { headers: { cookie } });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.ok(Array.isArray(body.entries));
    assert.equal(body.entries.length, 2);
    assert.equal(body.entries[0].action, "booking.cancelled");
    assert.equal(body.entries[1].action, "booking.created");

    const last = repos.calls.list.at(-1);
    assert.strictEqual(last.bookingId, 5);
    assert.equal(typeof last.bookingId, "number");
  });
});

test("audit: limit defaults to 100 and is capped at 500", async () => {
  await withApp(async ({ url, repos, loginAs }) => {
    const cookie = await loginAs("admin", "admin@test");

    await fetch(`${url}/api/admin/audit`, { headers: { cookie } });
    assert.equal(repos.calls.list.at(-1).limit, 100);

    await fetch(`${url}/api/admin/audit?limit=600`, { headers: { cookie } });
    assert.equal(repos.calls.list.at(-1).limit, 500);
  });
});