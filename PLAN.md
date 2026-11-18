# ClinicDesk — Build Plan

## 1. Goal

A small, single-tenant clinic appointment app. Users log in as one of three roles:

- **Patients** browse doctors' free 30-minute slots, then book or cancel them.
- **Doctors** manage their weekly availability and see (and can cancel) their own bookings.
- **Admins** see every booking and the full booking audit log. They also create doctor accounts.

Data lives in two stores:

- **Postgres:** users, sessions, availability and bookings.
- **MongoDB:** every booking change (create or cancel) is also appended as a document to an audit log.

Double booking is prevented **by Postgres itself**, through a partial unique index (section 5).

**Stack.** The app follows the `anuj-orbit/app-template` contract:
- Node 22, ESM (`"type": "module"`), Express 4.
- Listens on `PORT` (host `0.0.0.0`) and serves `GET /health`.
- Configured from env vars only. Root `Dockerfile` (unchanged from the template).
- `npm run lint`, plus `npm test` = `node --test test/*.test.js`.
- Frontend: static HTML plus small vanilla-JS ES modules in `public/`, served by `express.static`. No build step.
- No new npm dependencies beyond the template's `express`, `pg` and `mongodb`. Use `node:crypto` for scrypt and tokens, and parse cookies by hand.

**Non-goals:** payments, email, SMS, multi-tenancy, password reset, holidays or one-off exceptions, DST-aware time zones, login rate limiting (noted as follow-up).

## 2. Configuration (env only; never commit real values)

| Var | Required | Default | Purpose |
|---|---|---|---|
| `PORT` | no | 3000 | HTTP port |
| `DATABASE_URL` | prod: yes | — | Postgres. If unset and `NODE_ENV!=production` → in-memory repos (dev/test) |
| `MONGODB_URI` | prod: yes | — | MongoDB (db name taken from the URI). If unset in non-prod → in-memory audit |
| `ADMIN_EMAIL`, `ADMIN_PASSWORD` | first boot | — | Bootstraps one admin if no user with that email exists. Never logged |
| `SESSION_TTL_HOURS` | no | 168 | Session lifetime |
| `COOKIE_SECURE` | no | `false` | Set `true` only behind HTTPS (the sslip.io URL is plain http, so a Secure cookie would break login) |
| `CLINIC_UTC_OFFSET_MINUTES` | no | 0 | Fixed clinic offset from UTC; must be a multiple of 30 (no DST) |
| `TEST_DATABASE_URL`, `TEST_MONGODB_URI` | CI only | — | Integration tests are **skipped** when unset |

`src/server.js` exits with code 1 and a clear message when `NODE_ENV=production` and `DATABASE_URL` or `MONGODB_URI` is missing. `.env.example` lists every var with placeholder values only.

## 3. Pages and endpoints

All API responses are JSON. Errors always use the shape `{"error":{"code":"<snake_code>","message":"..."}}`. Times are ISO-8601 UTC strings (`2026-11-23T09:00:00.000Z`).

**CSRF:** every `POST`/`PUT`/`PATCH` under `/api` must send `Content-Type: application/json`, otherwise the API returns **415**. Together with `SameSite=Lax` cookies, this blocks form-based CSRF. `DELETE` is exempt, because cross-site `DELETE` needs a CORS preflight anyway.

**Shapes:**
- **User:** `{id, email, name, role, specialty}`. Never includes the password hash.
- **Availability rule:** `{id, doctorId, dayOfWeek (0=Sun..6), startTime:"09:00", endTime:"12:30"}`.
- **Booking:** `{id, doctorId, doctorName, patientId, patientName, patientEmail, start, end, status:"booked"|"cancelled", createdAt, cancelledAt, cancelledBy}`.

### 3.1 Auth (Area A)

| Method | Path | Who | Result |
|---|---|---|---|
| POST | `/api/auth/register` `{email,password,name}` | anon | 201 `{user}` with role `patient`, sets `sid` cookie. 400 `validation` (email format, password ≥ 8, name 1–100). 409 `email_taken` |
| POST | `/api/auth/login` `{email,password}` | anon | 200 `{user}`, sets cookie. 401 `invalid_credentials` (same message for unknown email and wrong password) |
| POST | `/api/auth/logout` `{}` | any | 204. Deletes the session row and clears the cookie (idempotent) |
| GET | `/api/auth/session` | any | 200 `{user}`, or 401 `unauthenticated` |
| POST | `/api/admin/doctors` `{email,password,name,specialty?}` | admin | 201 `{user}` with role `doctor`. 409 `email_taken` |
| GET | `/api/admin/users?role=doctor\|patient\|admin` | admin | 200 `{users:[...]}` |

**Cookie:** `sid=<32 random bytes, base64url>; HttpOnly; SameSite=Lax; Path=/; Max-Age=TTL`, plus `Secure` when `COOKIE_SECURE=true`. Postgres stores only `sha256(token)`.

### 3.2 Booking and availability domain (Area B)

Everything here is mounted at `/api`.

| Method | Path | Who | Result |
|---|---|---|---|
| GET | `/api/doctors` | logged in | 200 `{doctors:[{id,name,specialty}]}` |
| GET | `/api/doctors/:id/slots?from=YYYY-MM-DD&days=7` | logged in | 200 `{doctorId, slots:[{start,end}]}`. Free, future slots only. `days` is 1–28 (default 7); `from` defaults to today in clinic time. 404 `doctor_not_found` |
| POST | `/api/bookings` `{doctorId, start}` | patient | 201 `{booking}`. 400 `validation` / `misaligned_slot` / `slot_in_past` / `too_far_ahead` (> 90 days) / `outside_availability`. 404 `doctor_not_found`. **409 `slot_taken`**. 409 `patient_busy` (the patient already has a booking at that time). 403 for non-patients |
| GET | `/api/bookings/mine` | patient | 200 `{bookings:[...]}`, sorted by start ascending |
| POST | `/api/bookings/:id/cancel` `{}` | patient (own), doctor (own), admin (any) | 200 `{booking}` with status `cancelled`. 404 when the booking doesn't exist or isn't visible to the caller. 409 `already_cancelled`. 400 `booking_in_past` |
| GET | `/api/doctor/availability` | doctor | 200 `{rules:[...]}`, own rules only |
| POST | `/api/doctor/availability` `{dayOfWeek,startTime,endTime}` | doctor | 201 `{rule}`. 400 `validation` (times not on :00/:30, start ≥ end, day outside 0–6). 409 `availability_overlap` (same doctor, same day, overlapping range) |
| PUT | `/api/doctor/availability/:id` `{dayOfWeek,startTime,endTime}` | doctor (own) | 200 `{rule}`. 400, 404 or 409 as for POST |
| DELETE | `/api/doctor/availability/:id` | doctor (own) | 204, or 404. Existing bookings are kept and still honoured |
| GET | `/api/doctor/bookings?from=&to=&status=` | doctor | 200 `{bookings:[...]}`, own bookings only |

Times use `"HH:MM"` in clinic-local time. `endTime` may be `"24:00"`.

### 3.3 Admin views (Area C)

| Method | Path | Who | Result |
|---|---|---|---|
| GET | `/api/admin/bookings?status=&doctorId=&from=&to=&limit=200` | admin | 200 `{bookings:[...]}`, sorted by start descending. `limit` max 500 |
| GET | `/api/admin/audit?bookingId=&limit=100` | admin | 200 `{entries:[...]}`, sorted by `at` descending. `limit` max 500 |

Anonymous callers get 401 and other roles get 403.

### 3.4 Pages (Area C, static, `public/`)

Each page has a `#status` element with `aria-live="polite"`, a header showing the user's name, and a logout button.

On load, each page calls `GET /api/auth/session`:
- 401 → redirect to `/`.
- Wrong role → redirect to that role's own page.

| Page | Contents (required element ids) |
|---|---|
| `/` (`index.html`) | Login form `#login-form`, register form `#register-form`. On success, redirect by role: `/patient.html`, `/doctor.html` or `/admin.html` |
| `/patient.html` | `#doctor-select`, `#from-date`, slot grid `#slots` (one button per free slot → book), table `#my-bookings` with Cancel buttons. On a 409 it shows "That slot was just taken" and reloads the slots |
| `/doctor.html` | `#availability-list` (rules with edit/delete) and `#availability-form` (day select; start/end selects in 30-min steps). Table `#doctor-bookings` (upcoming bookings, Cancel) |
| `/admin.html` | `#all-bookings` table with filters `#filter-status` and `#filter-doctor`, plus Cancel. `#audit-log` table with `#filter-booking-id`. `#doctor-form` (creates a doctor) |

## 4. Data model

### 4.1 Postgres (users, sessions, availability, bookings)

Migrations are plain SQL files in `src/data/migrations/`. `src/data/migrate.js` applies them in filename order:
- It records each applied file in `schema_migrations(name TEXT PRIMARY KEY, applied_at TIMESTAMPTZ DEFAULT now())`.
- Each file runs in its own transaction.
- The whole run is guarded by `pg_advisory_lock(727001)`.
- Table names are never schema-qualified, so tests can use an isolated `search_path`.

`001_users_sessions.sql` (Area A):
```sql
CREATE TABLE users (
  id            INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  email         TEXT NOT NULL,
  password_hash TEXT NOT NULL,              -- "scrypt$<saltHex>$<hashHex>", N=16384 r=8 p=1 keylen=64
  name          TEXT NOT NULL,
  role          TEXT NOT NULL CHECK (role IN ('patient','doctor','admin')),
  specialty     TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX users_email_lower_uq ON users (lower(email));

CREATE TABLE sessions (
  token_hash TEXT PRIMARY KEY,              -- sha256 hex of cookie token
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX sessions_user_idx ON sessions (user_id);
```

`002_availability_bookings.sql` (Area B):
```sql
CREATE TABLE availability (
  id           INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  doctor_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  day_of_week  SMALLINT NOT NULL CHECK (day_of_week BETWEEN 0 AND 6),        -- clinic-local, 0 = Sunday
  start_minute SMALLINT NOT NULL CHECK (start_minute BETWEEN 0 AND 1410 AND start_minute % 30 = 0),
  end_minute   SMALLINT NOT NULL CHECK (end_minute BETWEEN 30 AND 1440 AND end_minute % 30 = 0),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (end_minute > start_minute)
);
CREATE INDEX availability_doctor_day_idx ON availability (doctor_id, day_of_week);

CREATE TABLE bookings (
  id           INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  doctor_id    INTEGER NOT NULL REFERENCES users(id),
  patient_id   INTEGER NOT NULL REFERENCES users(id),
  slot_start   TIMESTAMPTZ NOT NULL,          -- slot end = slot_start + 30 min (computed in app; a
                                              -- generated column is not allowed: timestamptz+interval is not IMMUTABLE)
  status       TEXT NOT NULL DEFAULT 'booked' CHECK (status IN ('booked','cancelled')),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  cancelled_at TIMESTAMPTZ,
  cancelled_by INTEGER REFERENCES users(id),
  CHECK (doctor_id <> patient_id),
  CHECK (EXTRACT(EPOCH FROM slot_start)::bigint % 1800 = 0)   -- exactly on a :00/:30 boundary
);
-- THE double-booking guard: at most one ACTIVE booking per doctor per slot.
CREATE UNIQUE INDEX bookings_doctor_slot_active_uq  ON bookings (doctor_id,  slot_start) WHERE status = 'booked';
-- A patient cannot be in two places at once.
CREATE UNIQUE INDEX bookings_patient_slot_active_uq ON bookings (patient_id, slot_start) WHERE status = 'booked';
CREATE INDEX bookings_slot_start_idx ON bookings (slot_start);
```

### 4.2 MongoDB (booking audit log only)

The audit log is the collection `booking_audit`, in the database named by `MONGODB_URI`.

The repo creates its indexes once, lazily, on first use: `{bookingId: 1, at: -1}` and `{at: -1}`. Entries are append-only; nothing in the app updates or deletes them.

Each document looks like this:
```json
{
  "_id": "ObjectId",
  "action": "booking.created",            // or "booking.cancelled"
  "bookingId": 42,
  "at": "ISODate",
  "actor": { "id": 7, "role": "patient", "email": "pat@example.com" },
  "doctorId": 3, "patientId": 7,
  "slotStart": "ISODate",
  "before": null,                          // or { "status": "booked" }
  "after":  { "status": "booked" },        // or { "status": "cancelled" }
  "meta": { "ip": "1.2.3.4", "userAgent": "..." }
}
```
The API returns each entry with `id` (the hex of `_id`) instead of `_id`, and with dates as ISO strings.

**Write semantics.** The service writes the audit entry *after* the Postgres commit succeeds:
- It awaits the write and retries once.
- If both attempts fail, it calls `console.error("AUDIT_WRITE_FAILED", JSON.stringify(event))`, so the event lands in container logs. The booking still succeeds.
- A Postgres outbox table is a documented follow-up, not v1 scope.

## 5. Double-booking prevention (exact strategy)

1. **Validation before touching the DB.** This lives in `src/booking/service.js`. The caller must be a patient, and the doctor must exist with role `doctor`. `start` must:
   - parse as a date;
   - satisfy `ms % 1_800_000 === 0`;
   - be later than `now`;
   - be no more than 90 days ahead.

   The service then converts `start` to clinic-local `{dayOfWeek, minuteOfDay}` with `CLINIC_UTC_OFFSET_MINUTES`.
2. **One transaction in the repo.** `src/data/pg/bookings.js` `create()`:
   ```sql
   BEGIN;
   SELECT id FROM availability
    WHERE doctor_id = $1 AND day_of_week = $2
      AND start_minute <= $3 AND end_minute >= $3 + 30
    LIMIT 1 FOR SHARE;                       -- locks the rule so a concurrent DELETE waits
   -- 0 rows → ROLLBACK, throw ValidationError('outside_availability')
   INSERT INTO bookings (doctor_id, patient_id, slot_start) VALUES ($1, $4, $5) RETURNING *;
   COMMIT;
   ```
   There is no SELECT-then-INSERT check for existing bookings. **The partial unique index `bookings_doctor_slot_active_uq` is the arbiter.**

   If two transactions insert the same `(doctor_id, slot_start)`, the second one blocks on the index entry. Once the first commits, the second fails with SQLSTATE `23505`. The repo catches `23505` and maps it by `err.constraint`:
   - `bookings_doctor_slot_active_uq` → `ConflictError('slot_taken')` (HTTP 409);
   - `bookings_patient_slot_active_uq` → `ConflictError('patient_busy')` (HTTP 409).

   It always issues `ROLLBACK` and releases the client in `finally`.
3. **Cancel is a single conditional UPDATE:**
   `UPDATE bookings SET status='cancelled', cancelled_at=now(), cancelled_by=$2 WHERE id=$1 AND status='booked' RETURNING *`.
   - If 0 rows come back, the service re-reads the row to decide between 404 and 409 `already_cancelled`.
   - Cancelled rows fall outside the partial index, so the slot becomes bookable again right away.
4. **Availability overlap.** `src/data/pg/availability.js` `create`/`update` run in one transaction:
   - Take `SELECT pg_advisory_xact_lock(doctor_id)`.
   - Then check `SELECT 1 FROM availability WHERE doctor_id=$1 AND day_of_week=$2 AND id <> $id AND start_minute < $end AND end_minute > $start`. A hit → `ConflictError('availability_overlap')`.
5. **The memory repo mirrors this.** `src/data/memory/bookings.js` keeps `Map<"doctorId|startMs", bookingId>` and `Map<"patientId|startMs", bookingId>` for active bookings. It runs the check and insert synchronously, with no `await` between them, so it is atomic on the JS event loop. It throws the same error types and codes.
6. **Proven by tests.**
   - `test/bookings.test.js` (memory): two `Promise.all` POSTs for the same slot → exactly one 201 and one 409 `slot_taken`.
   - `test/pg.bookings.test.js` (real Postgres): 10 concurrent `bookings.create` calls for one slot → exactly 1 resolves and 9 reject with `slot_taken`. After a cancel, a rebook succeeds.

## 6. Shared contracts (frozen in Phase 0; change only via the owning leader)

**Errors.** `src/errors.js` exports:
- `HttpError(status, code, message)` and its subclasses `ValidationError` (400), `AuthError` (401), `ForbiddenError` (403), `NotFoundError` (404), `ConflictError` (409).
- `wrap(fn)`, which wraps an async handler so Express 4 forwards rejected promises.
- `errorHandler`, which maps `HttpError` to the JSON error shape and anything else to 500 `internal`. It logs 500s without leaking stack traces to the client.

**Config.** `src/config.js` exports `loadConfig(env = process.env)`, returning `{sessionTtlHours, cookieSecure, clinicOffsetMinutes, adminEmail, adminPassword}`.

**Router factories.** Each is called as `xRouter({repos, config})` and returns an `express.Router`:
- `authRouter` (`src/routes/auth.js`);
- `adminUsersRouter` (`src/routes/adminUsers.js`);
- `bookingRouter` (`src/routes/booking.js`);
- `adminRouter` (`src/routes/admin.js`).

**Middleware.** `src/auth/middleware.js` exports:
- `loadSession({repos})`, which sets `req.user` (User shape) or `null`;
- `requireAuth` (401 `unauthenticated`);
- `requireRole(...roles)` (401, or 403 `forbidden`).

**Session helpers.** `src/auth/session.js` exports `newToken()`, `hashToken(t)`, `parseCookies(header)`, `sessionCookie(token, maxAgeSec, secure)` and `clearSessionCookie()`.

**Repos.** `src/repos.js` exports `buildRepos({pool, getMongoDb} = defaults from src/db.js)`, which returns `{users, sessions, availability, bookings, audit}`:
- Postgres-backed implementations are used when `pool` is set, memory ones otherwise.
- The Mongo audit is used when `getMongoDb` is set, memory otherwise.

Every repo method is async:
- **users:** `create({email,passwordHash,name,role,specialty})` (throws `ConflictError('email_taken')`), `findByEmail(email)` (returns `{...user, passwordHash}` or null), `findById(id)`, `listByRole(role)`.
- **sessions:** `create({tokenHash,userId,expiresAt})`, `findValid(tokenHash, now)` (returns `{userId, expiresAt}` or null), `delete(tokenHash)`, `deleteExpired(now)`.
- **availability:** `listByDoctor(doctorId)`, `create({doctorId,dayOfWeek,startMinute,endMinute})`, `update(id, doctorId, {dayOfWeek,startMinute,endMinute})` (returns the rule or null), `delete(id, doctorId)` (returns a boolean). Repo rules use minutes; the HH:MM conversion happens in `src/booking/slots.js`.
- **bookings:** `create({doctorId,patientId,slotStart:Date,dayOfWeek,startMinute})`, `findById(id)`, `cancel(id, cancelledBy)` (returns the Booking, or null if it was not active), `listByPatient(patientId)`, `listByDoctor(doctorId,{from,to,status})`, `listBookedForDoctorBetween(doctorId, from:Date, to:Date)`, `listAll({status,doctorId,from,to,limit})`. All of them return the Booking shape, with names joined in.
- **audit:** `record(event)`, `list({bookingId, limit})`.

**App wiring.** `src/app.js` builds the app in this order:
1. `createApp({repos = buildRepos(), config = loadConfig()} = {})`.
2. The 415 JSON guard, then `express.json({limit:'100kb'})`.
3. Static files, then `/health` (unchanged from the template), then `loadSession`.
4. Routers: `/api/auth` → auth, `/api/admin` → adminUsers, `/api/admin` → admin, `/api` → booking.
5. `/api/*` → 404 `not_found`, then `errorHandler`.

**Boot.** `src/server.js`:
1. Runs the production env check.
2. If `DATABASE_URL` is set, runs `migrate(getPg())`.
3. Runs `seedAdmin(repos, config)`.
4. Calls `listen(PORT, '0.0.0.0')`.

**Test helpers.** `test/helpers.js` exports:
- `startApp({repos?})` → `{url, repos, close}`, using memory repos merged with any overrides;
- `client(url)` → `{get, post, put, del}`, each returning `{status, body, headers}`. It keeps a cookie jar and always sends `content-type: application/json`;
- `createUser(repos, {role, email?, name?, passwordHash?, specialty?})` → user;
- `loginAs(repos, url, user)`, which inserts a session directly through `repos.sessions` and returns a `client` that already holds the cookie. B and C use this, so they don't depend on Area A's login route.

The helper file name does not match `*.test.js`, so `node --test` never runs it as a test.

## 7. Phase 0 — scaffold (blocking, before the leader batch)

The **Manager** dispatches **1 `worker-free` leaf** in the repo after the template is copied in, and runs it before step 3 of the dev-team workflow. Scope:
- Every file below exists: real implementations where marked, stubs elsewhere.
- Stub routers return an empty `express.Router()`. Stub repo factories return objects whose methods throw `Error('not implemented')`.
- `npm run lint && npm test` passes.

| File | Phase 0 content | Owner afterwards |
|---|---|---|
| `package.json` | `name: clinicdesk`; scripts `start: node src/server.js`, `lint: node scripts/lint.js`, `test: node --test test/*.test.js`; deps unchanged | Manager (no one edits) |
| `scripts/lint.js` | Runs `node --check` on every `.js` under `src/`, `test/`, `public/js/` and `scripts/`, via `spawnSync(process.execPath, ['--check', f])`. Exits 1 on any failure | Manager |
| `.github/workflows/ci.yml` | Adds `services:` to the `test` job: `postgres:16` (`POSTGRES_PASSWORD: postgres`, a throwaway CI-only container, not a secret; with a health-cmd) and `mongo:7`. Adds env `TEST_DATABASE_URL=postgres://postgres:postgres@localhost:5432/postgres` and `TEST_MONGODB_URI=mongodb://localhost:27017/clinicdesk_test`. The rest of the file stays unchanged | Manager |
| `.env.example` | All vars from section 2, with placeholders | Manager |
| `src/errors.js`, `src/config.js`, `src/app.js` (wiring above), `src/repos.js`, `src/auth/session.js`, `src/auth/middleware.js` | **Real** implementations | A |
| `src/data/memory/users.js`, `src/data/memory/sessions.js`, `src/data/memory/audit.js` | **Real** (small, in-memory) | A |
| `test/helpers.js` | **Real** | A |
| Stubs: `src/routes/auth.js`, `src/routes/adminUsers.js`, `src/data/pg/users.js`, `src/data/pg/sessions.js`, `src/data/mongo/audit.js` | Stub | A |
| Stubs: `src/routes/booking.js`, `src/data/pg/availability.js`, `src/data/pg/bookings.js`, `src/data/memory/availability.js`, `src/data/memory/bookings.js` | Stub | B |
| Stub: `src/routes/admin.js` | Stub | C |

Phase 0 acceptance:
- `npm ci && npm run lint && npm test` exits 0, and the template's `test/health.test.js` passes unchanged.
- `PORT=3999 node src/server.js & sleep 1; curl -s localhost:3999/health` → `{"status":"ok","postgres":"not_configured","mongo":"not_configured"}`.
- `curl -s -XPOST localhost:3999/api/auth/logout` (no content-type) → 415.

## 8. Areas and exact file ownership (non-overlapping)

A worker edits **only** files in its own area. Contract changes go through the owning leader. `Dockerfile`, `package.json`, `package-lock.json`, `scripts/` and `.github/` are **frozen** after Phase 0.

### Area A — Auth + data layer (`lead-deep`)
```
src/server.js  src/app.js  src/db.js  src/config.js  src/errors.js  src/repos.js  src/seed.js
src/auth/password.js  src/auth/session.js  src/auth/middleware.js
src/data/migrate.js  src/data/migrations/001_users_sessions.sql
src/data/pg/users.js  src/data/pg/sessions.js
src/data/memory/users.js  src/data/memory/sessions.js  src/data/memory/audit.js
src/data/mongo/audit.js
src/routes/auth.js  src/routes/adminUsers.js
test/helpers.js  test/health.test.js  test/password.test.js  test/auth.test.js
test/adminUsers.test.js  test/pg.users.test.js  test/mongo.audit.test.js
README.md
```

Worker split (3 × `worker-free`, all in one batch):
- **A1 — password and auth routes.** Files: `password.js` (`hashPassword`, `verifyPassword` using scrypt and `timingSafeEqual`), `routes/auth.js`, `routes/adminUsers.js`, `seed.js`, plus their tests.
- **A2 — Postgres data layer.** Files: `db.js`, `migrate.js`, `001_*.sql`, `pg/users.js`, `pg/sessions.js`, the boot sequence in `server.js` (including the production env check), and `pg.users.test.js`.
- **A3 — Mongo audit.** Files: `mongo/audit.js`, which takes `(getMongoDb, collectionName='booking_audit')`, creates indexes lazily and maps `_id` → `id`. Also hardens the memory audit and adds `mongo.audit.test.js`. A3 also writes the README.

### Area B — Booking + availability domain (`lead`)
```
src/booking/slots.js  src/booking/service.js
src/routes/booking.js
src/data/migrations/002_availability_bookings.sql
src/data/pg/availability.js  src/data/pg/bookings.js
src/data/memory/availability.js  src/data/memory/bookings.js
test/slots.test.js  test/availability.test.js  test/bookings.test.js  test/pg.bookings.test.js
```

Worker split (3 × `worker-free`):
- **B1 — slot math.** `slots.js`: pure, no I/O. Exports `parseHHMM` (`"09:30"` → 570; must be 30-aligned; `"24:00"` allowed as an end), `formatHHMM`, `localParts(date, offsetMin)` → `{dayOfWeek, minuteOfDay, dateStr}`, and `generateSlots({rules, from, days, offsetMinutes, now, bookedStartMs:Set})` → `[{start,end}]` (sorted, deduped, future only). Plus `slots.test.js`.
- **B2 — repos.** Files: `002_*.sql`, the Postgres and memory availability and bookings repos, and `pg.bookings.test.js` (the concurrency test).
- **B3 — service and routes.** Files: `service.js` (`createBooking`, `cancelBooking`, with audit emission per section 4.2; availability CRUD validation), `routes/booking.js`, `availability.test.js`, `bookings.test.js`.

B1 and B2 run in parallel. B3 codes against the section 6 contracts and can run in the same batch, but its tests are only judged after B1 and B2 pass review.

### Area C — Frontend/UI + admin views (`lead`)
```
src/routes/admin.js
public/index.html  public/patient.html  public/doctor.html  public/admin.html
public/css/app.css
public/js/api.js  public/js/auth.js  public/js/patient.js  public/js/doctor.js  public/js/admin.js
test/admin.test.js  test/ui.test.js
```

Worker split (3 × `worker-free`):
- **C1 — admin API and shared frontend client.** Files: `routes/admin.js`, `admin.test.js`, `js/api.js`, `ui.test.js`.
  - `admin.test.js` may inject stub `bookings.listAll` and `audit.list` through `startApp({repos})`, so it does not depend on B.
  - `js/api.js` is a fetch wrapper: JSON in and out; throws `{status, code, message}`; exports `api.get/post/put/del`, `requireRole(role)` (session check plus redirect), `logout()` and `setStatus(msg, kind)`.
- **C2 — login, patient page and stylesheet.** Files: `index.html`, `patient.html`, `js/auth.js`, `js/patient.js`, and `css/app.css`, which defines the class vocabulary `.container .card .btn .btn-primary .btn-danger .table .status .status-error .status-ok .slots .slot .form-row`. The layout is mobile-first and works at 390px.
- **C3 — doctor and admin pages.** Files: `doctor.html`, `admin.html`, `js/doctor.js`, `js/admin.js`. They use only the CSS classes above.

All pages load scripts with `<script type="module" src="/js/...">`. No inline handlers and no external CDNs. User-supplied text is inserted with `textContent` only, never `innerHTML`.

## 9. Team sizing

| Unit | Route | Workers | Reviewer |
|---|---|---|---|
| Phase 0 scaffold (Manager-dispatched) | — | 1 × `worker-free` | the Manager checks lint and tests itself |
| Leader A — Auth + data layer | **`lead-deep`** (auth, sessions, roles, multi-DB) | 3 × `worker-free` | 1 × `reviewer-free` |
| Leader B — Booking + availability | **`lead`** (strategy fully specified above; escalate a task to a paid `worker` after 2 failed reviews) | 3 × `worker-free` | 1 × `reviewer-free` |
| Leader C — Frontend/UI + admin views | **`lead`** | 3 × `worker-free` | 1 × `reviewer-free` |

**Totals:** 3 leaders (1 `lead-deep`, 2 `lead`), 10 free workers including Phase 0, and 3 free reviewers.

Leaders run in **one parallel batch** after Phase 0. Leaders don't commit; the Manager integrates and runs the full suite.

## 10. Acceptance criteria (reviewer-testable)

Global, after integration:
- `npm ci && npm run lint && npm test` exits 0 locally. With no `TEST_*` vars, the pg/mongo tests report as skipped.
- In CI (Postgres and Mongo services present), every test runs and passes.
- `docker build .` succeeds.
- `git grep -nE 'postgres://[^ ]*:[^@ ]+@|mongodb(\+srv)?://[^ ]*:[^@ ]+@'` matches only `.env.example` placeholders and the CI throwaway URL.

The curl checks below assume a local memory-mode server, started with throwaway local-only values:
`ADMIN_EMAIL=admin@clinic.test ADMIN_PASSWORD=admin-pass-123 PORT=3000 node src/server.js`
with `B=http://localhost:3000; J='content-type: application/json'`.

### Area A
1. `npm test` → `password.test.js`, `auth.test.js` and `adminUsers.test.js` pass. They cover:
   - a hash round-trip, and a wrong password failing;
   - the stored hash starting with `scrypt$`;
   - register → 201, the role is always `patient` even if the body says `"role":"admin"`, and the response never contains `password`/`passwordHash`;
   - a duplicate email (case-insensitive) → 409;
   - a bad login → 401 with the same message for an unknown email and a wrong password;
   - logout → the session is gone, and the next `/session` → 401;
   - an expired session → 401;
   - a patient calling `POST /api/admin/doctors` → 403, an admin → 201.
2. `curl -s -c a.jar -XPOST $B/api/auth/register -H "$J" -d '{"email":"p@x.io","password":"secret123","name":"Pat"}'` → 201 and `"role":"patient"`. The `Set-Cookie` header contains `HttpOnly` and `SameSite=Lax`.
3. `curl -s -b a.jar $B/api/auth/session` → 200 `{user}`. `curl -s -b a.jar -XPOST $B/api/auth/logout -H "$J" -d '{}' -o /dev/null -w '%{http_code}'` → `204`, and `/session` then returns 401.
4. `curl -s -c adm.jar -XPOST $B/api/auth/login -H "$J" -d '{"email":"admin@clinic.test","password":"admin-pass-123"}'` → 200, role `admin` (the seed works). Then `curl -s -b adm.jar -XPOST $B/api/admin/doctors -H "$J" -d '{"email":"d@x.io","password":"secret123","name":"Dr Dee","specialty":"GP"}'` → 201, role `doctor`.
5. `curl -s -XPOST $B/api/auth/login -d 'email=x'` → 415.
6. With `TEST_DATABASE_URL`, `pg.users.test.js`:
   - migrates into an isolated schema `test_<pid>_<rand>` (via the pool option `options: '-c search_path=...'`) and drops it afterwards;
   - asserts that re-running `migrate` is a no-op;
   - checks the case-insensitive unique email.
7. With `TEST_MONGODB_URI`, `mongo.audit.test.js` records 3 events in a temporary collection and `list({bookingId})` returns them newest-first with string `id`s. The collection is dropped afterwards.
8. `NODE_ENV=production node src/server.js` without the DB vars exits 1 with a message naming the missing vars.

### Area B
1. `slots.test.js`:
   - `parseHHMM('09:15')` throws, and `parseHHMM('24:00')` is allowed as an end;
   - a Monday rule of 09:00–10:30 → 3 slots on a Monday, 0 on a Tuesday;
   - booked starts are excluded, and past slots are excluded (with an injected `now`);
   - `offsetMinutes=60` shifts the UTC starts by −60 min;
   - overlapping rules don't produce duplicate slots.
2. `availability.test.js` (memory, via `loginAs`):
   - doctor CRUD → 201/200/204;
   - a misaligned time → 400, and start ≥ end → 400;
   - an overlap on the same day → 409 `availability_overlap`, while an adjacent range (10:00–11:00 after 09:00–10:00) → 201;
   - editing or deleting another doctor's rule → 404;
   - a patient calling the doctor routes → 403.
3. `bookings.test.js` (memory):
   - a patient books a free slot → 201, and that slot disappears from `/slots`;
   - **`Promise.all` of two bookings for the same slot → exactly one 201 and one 409 `slot_taken`**;
   - the same patient booking the same time with another doctor → 409 `patient_busy`;
   - a misaligned `start` → 400 `misaligned_slot`; outside availability → 400 `outside_availability`; in the past → 400 `slot_in_past`;
   - a doctor or admin calling POST `/api/bookings` → 403;
   - cancel: by the owner → 200; another patient → 404; a second cancel → 409 `already_cancelled`; rebooking after cancel → 201;
   - the doctor sees the booking in `/api/doctor/bookings`;
   - **the audit repo holds exactly 1 `booking.created` + 1 `booking.cancelled` entry per booking, with the actor role**;
   - with an audit repo whose `record` always throws, booking still returns 201 and `console.error` receives `AUDIT_WRITE_FAILED`.
4. `pg.bookings.test.js` (with `TEST_DATABASE_URL`, isolated schema): **10 concurrent `bookings.create` for the same doctor and slot → 1 fulfilled, 9 rejected with `ConflictError` code `slot_taken`.** Also:
   - after a cancel, a rebook succeeds;
   - a direct SQL `INSERT` with `slot_start` at `:15` fails the CHECK constraint;
   - `\d bookings` (or `pg_indexes`) shows `bookings_doctor_slot_active_uq` with `WHERE (status = 'booked'::text)`.
5. curl, using the doctor from A4 logged in as `doc.jar` and the patient as `a.jar`:
   1. `curl -s -b doc.jar -XPOST $B/api/doctor/availability -H "$J" -d '{"dayOfWeek":1,"startTime":"09:00","endTime":"12:00"}'` → 201.
   2. `curl -s -b a.jar "$B/api/doctors/<docId>/slots?days=14"` → 12 slots (6 per Monday × 2 Mondays; fewer if today is a Monday after 09:00 clinic time), each 30 min long and starting on a Monday.
   3. `curl -s -b a.jar -XPOST $B/api/bookings -H "$J" -d '{"doctorId":<docId>,"start":"<slot0>"}'` → 201. Running the same command a second time, as a second patient, → 409 `slot_taken`.
   4. `curl -s -b a.jar -XPOST $B/api/bookings/<id>/cancel -H "$J" -d '{}'` → 200 `"status":"cancelled"`.

### Area C
1. `admin.test.js`:
   - anonymous → 401 and patient/doctor → 403 on both admin endpoints;
   - an admin gets `{bookings}` sorted by start descending, with `status` and `doctorId` filters applied;
   - `limit` is capped at 500;
   - `/api/admin/audit?bookingId=5` passes `bookingId` through as a number, and returns `{entries}`.
2. `ui.test.js`:
   - `GET /`, `/patient.html`, `/doctor.html` and `/admin.html` → 200 `text/html`, and each page contains its required ids from section 3.4, plus `aria-live`;
   - every `/js/*.js` and `/css/app.css` → 200;
   - no page references `http://` or `https://` CDNs;
   - `public/js/*.js` contains no `innerHTML =` assignment with a template literal.
3. curl:
   - `curl -s -b adm.jar "$B/api/admin/bookings?status=cancelled"` lists the cancelled booking from B5, with `doctorName` and `patientName`;
   - `curl -s -b adm.jar "$B/api/admin/audit?bookingId=<id>"` → 2 entries, `booking.cancelled` first;
   - `curl -s -b a.jar $B/api/admin/bookings -o /dev/null -w '%{http_code}'` → `403`.
4. Manual/browser check (Manager step 7, at 1280×900 and 390×844):
   1. Register a patient.
   2. Book a slot. `#status` shows success, and the slot moves into `#my-bookings`.
   3. Cancel it.
   4. Log in as admin. `#all-bookings` and `#audit-log` show both events.
   5. Log in as the doctor. Add a rule; it appears in `#availability-list`.
   6. Visiting `/admin.html` as a patient redirects to `/patient.html`.

## 11. Cost estimate (USD)

| Item | Route | Estimate |
|---|---|---|
| Planning (this document) | `lead-deep` | 0.50 |
| Phase 0 scaffold | `worker-free` | 0.00 |
| Leader A (split, review loop, spot checks) | `lead-deep` | 0.90 |
| Leader B | `lead` | 0.40 |
| Leader C | `lead` | 0.35 |
| 9 area workers + 3 reviewers | free | 0.00 |
| Reserve for paid `worker` escalations (≤ 2 tasks) | `worker` | 0.20 |
| Manager: intake, approvals, repo, CI fixes, provisioning, deploy, verify | cheap | 0.35 |
| **Total** | | **≈ 2.70** (expected range 2.00–3.50; under the 4.00 stop threshold) |

## 12. Risks and pitfalls for workers

- **Express 4 does not catch rejected promises.** Wrap every async handler with `wrap()` from `src/errors.js`.
- `pg` returns `INTEGER` as a JS number; that's why ids use `INTEGER` rather than `BIGINT`. `TIMESTAMPTZ` comes back as a `Date`, so call `.toISOString()` in repo mappers.
- `node --test` runs test files in **parallel processes**. Each Postgres test file must use its own schema, and each Mongo test its own collection. Never `TRUNCATE` shared tables.
- Keep `"test": "node --test test/*.test.js"` (glob, not a directory). Helper files must not end in `.test.js`.
- Don't set the `Secure` cookie flag by default: the deployed URL is plain HTTP.
- Never log passwords, password hashes, session tokens or connection strings. `.env` is gitignored; only `.env.example` is committed.
- `/health` must keep returning `{"status":"ok","postgres":"not_configured",...}` when no DB is configured, because the template test relies on it.
