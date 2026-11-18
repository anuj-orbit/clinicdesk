import crypto from "node:crypto";

// Fixed dummy hash for timing safety during unknown email lookup
const DUMMY_HASH = "scrypt$salt$deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef";

export async function hashPassword(plain) {
  if (typeof plain !== "string") throw new TypeError("plain must be a string");
  const salt = crypto.randomBytes(16);
  const keylen = 64;
  const N = 16384;
  const r = 8;
  const p = 1;
  
  return new Promise((resolve, reject) => {
    crypto.scrypt(plain, salt, keylen, { N, r, p }, (err, derivedKey) => {
      if (err) return reject(err);
      const saltHex = salt.toString('hex');
      const hashHex = derivedKey.toString('hex');
      resolve(`scrypt$${saltHex}$${hashHex}`);
    });
  });
}

export function verifyPassword(plain, stored) {
  if (typeof plain !== "string" || typeof stored !== "string") return false;
  if (!stored.startsWith("scrypt$")) return false;
  const parts = stored.split("$");
  if (parts.length !== 3) return false;
  const [_, saltHex, hashHex] = parts;
  if (!saltHex || !hashHex || saltHex.length !== 32 || hashHex.length !== 128) return false;
  
  const keylen = 64;
  const N = 16384;
  const r = 8;
  const p = 1;
  
  return new Promise((resolve) => {
    crypto.scrypt(plain, Buffer.from(saltHex, 'hex'), keylen, { N, r, p }, (err, derivedKey) => {
      if (err) return resolve(false);
      const hashBuf = Buffer.from(hashHex, 'hex');
      resolve(crypto.timingSafeEqual(derivedKey, hashBuf));
    });
  });
}

export { DUMMY_HASH };