import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { startApp, createUser, client } from "./helpers.js";

describe("auth routes", () => {
  let app;
  let repos;
  let url;
  let baseClient;

  beforeEach(async () => {
    app = await startApp();
    repos = app.repos;
    url = app.url;
    baseClient = client(url);
  });

  afterEach(async () => {
    await app.close();
  });

  test("register returns 201, role 'patient' even when body has role:'admin'", async () => {
    const res = await baseClient.post("/api/auth/register", {
      email: "new@clinic.test",
      password: "password123",
      name: "New Patient",
      role: "admin", // should be ignored
    });
    assert.equal(res.status, 201);
    assert.equal(res.body.user.role, "patient");
    assert.equal(res.body.user.email, "new@clinic.test");
    assert.equal(res.body.user.name, "New Patient");
  });

  test("register response contains no password or passwordHash", async () => {
    const res = await baseClient.post("/api/auth/register", {
      email: "nopass@clinic.test",
      password: "password123",
      name: "Test",
    });
    const json = JSON.stringify(res.body);
    assert.ok(!json.includes("password"));
    assert.ok(!json.includes("passwordHash"));
  });

  test("register sets cookie with sid, HttpOnly, SameSite=Lax, Path=/, Max-Age", async () => {
    const res = await baseClient.post("/api/auth/register", {
      email: "cookie@clinic.test",
      password: "password123",
      name: "Test",
    });
    const setCookie = res.headers.get("set-cookie");
    assert.ok(setCookie, "set-cookie header should exist");
    assert.ok(setCookie.includes("sid="), "cookie should contain sid=");
    assert.ok(setCookie.includes("HttpOnly"), "cookie should be HttpOnly");
    assert.ok(setCookie.includes("SameSite=Lax"), "cookie should have SameSite=Lax");
    assert.ok(setCookie.includes("Path=/"), "cookie should have Path=/");
    assert.ok(setCookie.includes("Max-Age="), "cookie should have Max-Age");
  });

  test("stored user hash starts with scrypt$", async () => {
    const res = await baseClient.post("/api/auth/register", {
      email: "hash@clinic.test",
      password: "password123",
      name: "Test",
    });
    assert.equal(res.status, 201);
    
    const stored = await repos.users.findByEmail("hash@clinic.test");
    assert.ok(stored.passwordHash.startsWith("scrypt$"), "stored password should be scrypt hash");
  });

  test("duplicate email differing only in case returns 409 email_taken", async () => {
    await baseClient.post("/api/auth/register", {
      email: "Case@clinic.test",
      password: "password123",
      name: "Test",
    });
    const res = await baseClient.post("/api/auth/register", {
      email: "CASE@clinic.test",
      password: "password123",
      name: "Test",
    });
    assert.equal(res.status, 409);
    assert.equal(res.body.error.code, "email_taken");
  });

  test("validation 400: bad email", async () => {
    const res = await baseClient.post("/api/auth/register", {
      email: "not-an-email",
      password: "password123",
      name: "Test",
    });
    assert.equal(res.status, 400);
    assert.equal(res.body.error.code, "validation");
  });

  test("validation 400: 7-char password", async () => {
    const res = await baseClient.post("/api/auth/register", {
      email: "short@clinic.test",
      password: "pass123",
      name: "Test",
    });
    assert.equal(res.status, 400);
    assert.equal(res.body.error.code, "validation");
  });

  test("validation 400: empty name", async () => {
    const res = await baseClient.post("/api/auth/register", {
      email: "empty@clinic.test",
      password: "password123",
      name: "",
    });
    assert.equal(res.status, 400);
    assert.equal(res.body.error.code, "validation");
  });

  test("validation 400: 101-char name", async () => {
    const res = await baseClient.post("/api/auth/register", {
      email: "longname@clinic.test",
      password: "password123",
      name: "a".repeat(101),
    });
    assert.equal(res.status, 400);
    assert.equal(res.body.error.code, "validation");
  });

  test("login success returns 200 and cookie", async () => {
    await baseClient.post("/api/auth/register", {
      email: "login@clinic.test",
      password: "password123",
      name: "Test",
    });
    
    const res = await baseClient.post("/api/auth/login", {
      email: "login@clinic.test",
      password: "password123",
    });
    
    assert.equal(res.status, 200);
    assert.equal(res.body.user.email, "login@clinic.test");
    assert.ok(res.headers.get("set-cookie")?.includes("sid="), "should set cookie on login");
  });

  test("unknown email and wrong password both return 401 with identical error bodies", async () => {
    const unknownRes = await baseClient.post("/api/auth/login", {
      email: "unknown@clinic.test",
      password: "password123",
    });
    
    await baseClient.post("/api/auth/register", {
      email: "known@clinic.test",
      password: "password123",
      name: "Test",
    });
    
    const wrongRes = await baseClient.post("/api/auth/login", {
      email: "known@clinic.test",
      password: "wrongpassword",
    });
    
    assert.equal(unknownRes.status, 401);
    assert.equal(wrongRes.status, 401);
    assert.deepEqual(unknownRes.body, wrongRes.body);
    assert.equal(unknownRes.body.error.code, "invalid_credentials");
    assert.equal(unknownRes.body.error.message, "Invalid email or password");
  });

  test("GET /session with cookie returns 200 user", async () => {
    const regRes = await baseClient.post("/api/auth/register", {
      email: "session@clinic.test",
      password: "password123",
      name: "Test",
    });
    assert.equal(regRes.status, 201);
    
    const sessionRes = await baseClient.get("/api/auth/session");
    assert.equal(sessionRes.status, 200);
    assert.equal(sessionRes.body.user.email, "session@clinic.test");
    assert.equal(sessionRes.body.user.name, "Test");
    assert.equal(sessionRes.body.user.role, "patient");
  });

  test("GET /session without cookie returns 401 unauthenticated", async () => {
    const freshClient = client(url);
    const res = await freshClient.get("/api/auth/session");
    assert.equal(res.status, 401);
    assert.equal(res.body.error.code, "unauthenticated");
  });

  test("logout returns 204, session row is gone, subsequent /session returns 401", async () => {
    const regRes = await baseClient.post("/api/auth/register", {
      email: "logout@clinic.test",
      password: "password123",
      name: "Test",
    });
    assert.equal(regRes.status, 201);
    
    // Get the session token from cookie
    const token = baseClient.getCookie("sid");
    assert.ok(token, "should have sid cookie");
    
    const logoutRes = await baseClient.post("/api/auth/logout", {});
    assert.equal(logoutRes.status, 204);
    
    // Verify session is gone from repo
    const { hashToken } = await import("../src/auth/session.js");
    const session = await repos.sessions.findValid(hashToken(token), new Date());
    assert.equal(session, null, "session should be deleted from repo");
    
    // Subsequent /session should return 401
    const sessionRes = await baseClient.get("/api/auth/session");
    assert.equal(sessionRes.status, 401);
    assert.equal(sessionRes.body.error.code, "unauthenticated");
  });

  test("logout anonymously returns 204", async () => {
    const anonClient = client(url);
    const res = await anonClient.post("/api/auth/logout", {});
    assert.equal(res.status, 204);
  });

  test("expired session returns 401", async () => {
    // Create a user
    await repos.users.create({
      email: "expired@clinic.test",
      passwordHash: "scrypt$" + "a".repeat(32) + "$" + "b".repeat(128),
      name: "Expired User",
      role: "patient",
    });
    
    // Create an expired session directly
    const { newToken, hashToken } = await import("../src/auth/session.js");
    const token = newToken();
    await repos.sessions.create({
      tokenHash: hashToken(token),
      userId: 1,
      expiresAt: new Date(Date.now() - 1000), // 1 second in the past
    });
    
    // Try to access /session with expired cookie
    const expiredClient = client(url, { sid: token });
    const res = await expiredClient.get("/api/auth/session");
    assert.equal(res.status, 401);
    assert.equal(res.body.error.code, "unauthenticated");
  });

  test("POST /api/auth/login without JSON content-type returns 415", async () => {
    // Use raw fetch to send non-JSON content-type
    const res = await fetch(`${url}/api/auth/login`, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
      },
      body: "email=x&password=y",
    });
    assert.equal(res.status, 415);
    const body = await res.json();
    assert.equal(body.error.code, "unsupported_media_type");
  });

  test("session for deleted/non-existent userId returns 401", async () => {
    // Create a valid session but for a user that doesn't exist
    const { newToken, hashToken } = await import("../src/auth/session.js");
    const token = newToken();
    await repos.sessions.create({
      tokenHash: hashToken(token),
      userId: 99999, // non-existent user
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    });
    
    const sessionClient = client(url, { sid: token });
    const res = await sessionClient.get("/api/auth/session");
    assert.equal(res.status, 401);
    assert.equal(res.body.error.code, "unauthenticated");
  });
});