import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { hashPassword, verifyPassword, DUMMY_HASH } from "../src/auth/password.js";

describe("password hashing", () => {
  test("round-trip: hash then verify with correct password returns true", async () => {
    const plain = "correct-horse-battery-staple";
    const hashed = await hashPassword(plain);
    const result = await verifyPassword(plain, hashed);
    assert.equal(result, true);
  });

  test("wrong password returns false", async () => {
    const plain = "correct-horse-battery-staple";
    const hashed = await hashPassword(plain);
    const result = await verifyPassword("wrong-password", hashed);
    assert.equal(result, false);
  });

  test("hash starts with 'scrypt$' and has 3 parts with correct hex lengths", async () => {
    const plain = "password123";
    const hashed = await hashPassword(plain);
    
    assert.ok(hashed.startsWith("scrypt$"), "hash should start with scrypt$");
    
    const parts = hashed.split("$");
    assert.equal(parts.length, 3, "hash should have 3 parts separated by $");
    
    const [prefix, saltHex, hashHex] = parts;
    assert.equal(prefix, "scrypt");
    assert.equal(saltHex.length, 32, "salt should be 32 hex chars (16 bytes)");
    assert.equal(hashHex.length, 128, "hash should be 128 hex chars (64 bytes)");
    assert.ok(/^[0-9a-f]+$/.test(saltHex), "salt should be hex");
    assert.ok(/^[0-9a-f]+$/.test(hashHex), "hash should be hex");
  });

  test("two hashes of same password differ (salt uniqueness)", async () => {
    const plain = "password123";
    const hash1 = await hashPassword(plain);
    const hash2 = await hashPassword(plain);
    
    assert.notEqual(hash1, hash2, "two hashes of same password should differ");
    
    // Both should still verify correctly
    assert.equal(await verifyPassword(plain, hash1), true);
    assert.equal(await verifyPassword(plain, hash2), true);
  });

  test("verifyPassword on malformed stored strings returns false without throwing", async () => {
    const plain = "password123";
    
    // Empty string
    assert.equal(await verifyPassword(plain, ""), false);
    
    // bcrypt format (wrong prefix)
    assert.equal(await verifyPassword(plain, "bcrypt$x$y"), false);
    
    // scrypt but wrong number of parts
    assert.equal(await verifyPassword(plain, "scrypt$zz$zz"), false);
    
    // scrypt but salt too short
    assert.equal(await verifyPassword(plain, "scrypt$short$" + "a".repeat(128)), false);
    
    // scrypt but hash too short
    assert.equal(await verifyPassword(plain, "scrypt$" + "a".repeat(32) + "$short"), false);
    
    // undefined input
    assert.equal(await verifyPassword(plain, undefined), false);
    
    // non-string input
    assert.equal(await verifyPassword(plain, null), false);
    assert.equal(await verifyPassword(plain, 123), false);
    assert.equal(await verifyPassword(123, "scrypt$" + "a".repeat(32) + "$" + "b".repeat(128)), false);
  });
});