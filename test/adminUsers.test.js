import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { startApp, createUser, loginAs } from "./helpers.js";

describe("adminUsers routes", () => {
  let app;
  let repos;
  let url;

  beforeEach(async () => {
    app = await startApp();
    repos = app.repos;
    url = app.url;
  });

  afterEach(async () => {
    await app.close();
  });

  test("anonymous POST /api/admin/doctors returns 401", async () => {
    const anonClient = (await import("./helpers.js")).client(url);
    const res = await anonClient.post("/api/admin/doctors", {
      email: "doc@clinic.test",
      password: "password123",
      name: "Dr. Test",
      specialty: "Cardiology",
    });
    assert.equal(res.status, 401);
  });

  test("patient POST /api/admin/doctors returns 403", async () => {
    const patient = await createUser(repos, { role: "patient" });
    const patientClient = await loginAs(repos, url, patient);
    
    const res = await patientClient.post("/api/admin/doctors", {
      email: "doc@clinic.test",
      password: "password123",
      name: "Dr. Test",
      specialty: "Cardiology",
    });
    assert.equal(res.status, 403);
  });

  test("admin POST /api/admin/doctors returns 201 with role 'doctor', specialty, no hash in body", async () => {
    const admin = await createUser(repos, { role: "admin" });
    const adminClient = await loginAs(repos, url, admin);
    
    const res = await adminClient.post("/api/admin/doctors", {
      email: "doc@clinic.test",
      password: "password123",
      name: "Dr. Test",
      specialty: "Cardiology",
    });
    
    assert.equal(res.status, 201);
    assert.equal(res.body.user.role, "doctor");
    assert.equal(res.body.user.email, "doc@clinic.test");
    assert.equal(res.body.user.name, "Dr. Test");
    assert.equal(res.body.user.specialty, "Cardiology");
    
    // Verify no password fields in response
    const json = JSON.stringify(res.body);
    assert.ok(!json.includes("password"));
    assert.ok(!json.includes("passwordHash"));
  });

  test("duplicate doctor email returns 409 email_taken", async () => {
    const admin = await createUser(repos, { role: "admin" });
    const adminClient = await loginAs(repos, url, admin);
    
    await adminClient.post("/api/admin/doctors", {
      email: "doc@clinic.test",
      password: "password123",
      name: "Dr. Test",
    });
    
    const res = await adminClient.post("/api/admin/doctors", {
      email: "DOC@clinic.test",
      password: "different123",
      name: "Dr. Other",
    });
    
    assert.equal(res.status, 409);
    assert.equal(res.body.error.code, "email_taken");
  });

  test("validation 400 for bad doctor input", async () => {
    const admin = await createUser(repos, { role: "admin" });
    const adminClient = await loginAs(repos, url, admin);
    
    // Bad email
    let res = await adminClient.post("/api/admin/doctors", {
      email: "not-an-email",
      password: "password123",
      name: "Dr. Test",
    });
    assert.equal(res.status, 400);
    assert.equal(res.body.error.code, "validation");
    
    // Short password
    res = await adminClient.post("/api/admin/doctors", {
      email: "doc2@clinic.test",
      password: "short",
      name: "Dr. Test",
    });
    assert.equal(res.status, 400);
    assert.equal(res.body.error.code, "validation");
    
    // Empty name
    res = await adminClient.post("/api/admin/doctors", {
      email: "doc3@clinic.test",
      password: "password123",
      name: "",
    });
    assert.equal(res.status, 400);
    assert.equal(res.body.error.code, "validation");
    
    // Long name
    res = await adminClient.post("/api/admin/doctors", {
      email: "doc4@clinic.test",
      password: "password123",
      name: "a".repeat(101),
    });
    assert.equal(res.status, 400);
    assert.equal(res.body.error.code, "validation");
    
    // Long specialty
    res = await adminClient.post("/api/admin/doctors", {
      email: "doc5@clinic.test",
      password: "password123",
      name: "Dr. Test",
      specialty: "a".repeat(101),
    });
    assert.equal(res.status, 400);
    assert.equal(res.body.error.code, "validation");
  });

  test("created doctor can log in via /api/auth/login with its password", async () => {
    const admin = await createUser(repos, { role: "admin" });
    const adminClient = await loginAs(repos, url, admin);
    
    await adminClient.post("/api/admin/doctors", {
      email: "doclogin@clinic.test",
      password: "doctorpass123",
      name: "Dr. Login",
      specialty: "Neurology",
    });
    
    const loginClient = (await import("./helpers.js")).client(url);
    const res = await loginClient.post("/api/auth/login", {
      email: "doclogin@clinic.test",
      password: "doctorpass123",
    });
    
    assert.equal(res.status, 200);
    assert.equal(res.body.user.role, "doctor");
    assert.equal(res.body.user.email, "doclogin@clinic.test");
    assert.equal(res.body.user.specialty, "Neurology");
  });

  test("GET /api/admin/users?role=doctor as admin returns doctor without hashes", async () => {
    const admin = await createUser(repos, { role: "admin" });
    const adminClient = await loginAs(repos, url, admin);
    
    await adminClient.post("/api/admin/doctors", {
      email: "doclist@clinic.test",
      password: "password123",
      name: "Dr. List",
      specialty: "Pediatrics",
    });
    
    const res = await adminClient.get("/api/admin/users?role=doctor");
    assert.equal(res.status, 200);
    assert.ok(Array.isArray(res.body.users));
    assert.ok(res.body.users.length >= 1);
    const doc = res.body.users.find(u => u.email === "doclist@clinic.test");
    assert.ok(doc, "doctor should be in list");
    assert.equal(doc.role, "doctor");
    assert.equal(doc.specialty, "Pediatrics");
    
    // No password fields
    const json = JSON.stringify(res.body);
    assert.ok(!json.includes("password"));
    assert.ok(!json.includes("passwordHash"));
  });

  test("GET /api/admin/users?role=bogus returns 400", async () => {
    const admin = await createUser(repos, { role: "admin" });
    const adminClient = await loginAs(repos, url, admin);
    
    const res = await adminClient.get("/api/admin/users?role=bogus");
    assert.equal(res.status, 400);
    assert.equal(res.body.error.code, "validation");
  });

  test("patient GET /api/admin/users returns 403", async () => {
    const patient = await createUser(repos, { role: "patient" });
    const patientClient = await loginAs(repos, url, patient);
    
    const res = await patientClient.get("/api/admin/users");
    assert.equal(res.status, 403);
  });

  describe("seedAdmin", () => {
    test("with config adminEmail/adminPassword on fresh memory repos creates an admin", async () => {
      const { seedAdmin } = await import("../src/seed.js");
      const { buildRepos } = await import("../src/repos.js");
      
      const freshRepos = buildRepos({ pool: null, getMongoDb: null });
      const config = {
        adminEmail: "Admin@Clinic.test",
        adminPassword: "admin-pass-123",
      };
      
      const result = await seedAdmin(freshRepos, config);
      assert.ok(result, "seedAdmin should return the created user");
      assert.equal(result.email, "admin@clinic.test");
      assert.equal(result.name, "Administrator");
      assert.equal(result.role, "admin");
      assert.equal(result.specialty, null);
    });

    test("calling seedAdmin twice creates only one admin", async () => {
      const { seedAdmin } = await import("../src/seed.js");
      const { buildRepos } = await import("../src/repos.js");
      
      const freshRepos = buildRepos({ pool: null, getMongoDb: null });
      const config = {
        adminEmail: "Admin@Clinic.test",
        adminPassword: "admin-pass-123",
      };
      
      await seedAdmin(freshRepos, config);
      await seedAdmin(freshRepos, config);
      
      const admins = await freshRepos.users.listByRole("admin");
      assert.equal(admins.length, 1, "should only have one admin after two seed calls");
    });

    test("seeded admin can log in via the API", async () => {
      const { seedAdmin } = await import("../src/seed.js");
      const { buildRepos } = await import("../src/repos.js");
      
      const freshRepos = buildRepos({ pool: null, getMongoDb: null });
      const config = {
        adminEmail: "Admin@Clinic.test",
        adminPassword: "admin-pass-123",
      };
      
      await seedAdmin(freshRepos, config);
      
      // Start app with the seeded repos
      const app = await startApp({ repos: freshRepos, config });
      const loginClient = (await import("./helpers.js")).client(app.url);
      
      const res = await loginClient.post("/api/auth/login", {
        email: "admin@clinic.test",
        password: "admin-pass-123",
      });
      
      assert.equal(res.status, 200);
      assert.equal(res.body.user.role, "admin");
      assert.equal(res.body.user.email, "admin@clinic.test");
      
      await app.close();
    });

    test("missing adminEmail/adminPassword returns null and creates nothing", async () => {
      const { seedAdmin } = await import("../src/seed.js");
      const { buildRepos } = await import("../src/repos.js");
      
      const freshRepos = buildRepos({ pool: null, getMongoDb: null });
      
      // No adminEmail
      let result = await seedAdmin(freshRepos, { adminPassword: "admin-pass-123" });
      assert.equal(result, null);
      
      // No adminPassword
      result = await seedAdmin(freshRepos, { adminEmail: "admin@test" });
      assert.equal(result, null);
      
      // Neither
      result = await seedAdmin(freshRepos, {});
      assert.equal(result, null);
      
      const admins = await freshRepos.users.listByRole("admin");
      assert.equal(admins.length, 0, "no admin should be created when vars missing");
    });
  });
});