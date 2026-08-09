import { randomBytes, scrypt, timingSafeEqual } from "node:crypto";

// Self-describing format: scrypt$N$r$p$saltB64$hashB64 — parameters can be
// raised later without invalidating existing hashes.
const N = 2 ** 15;
const R = 8;
const P = 1;
const KEYLEN = 64;
const MAXMEM = 256 * 1024 * 1024;

function scryptAsync(password: string, salt: Buffer, n: number, r: number, p: number): Promise<Buffer> {
  return new Promise((res, rej) => {
    scrypt(password, salt, KEYLEN, { N: n, r, p, maxmem: MAXMEM }, (err, key) =>
      err ? rej(err) : res(key),
    );
  });
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(32);
  const key = await scryptAsync(password, salt, N, R, P);
  return `scrypt$${N}$${R}$${P}$${salt.toString("base64")}$${key.toString("base64")}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;
  const [, nStr, rStr, pStr, saltB64, hashB64] = parts;
  const salt = Buffer.from(saltB64, "base64");
  const expected = Buffer.from(hashB64, "base64");
  const key = await scryptAsync(password, salt, Number(nStr), Number(rStr), Number(pStr));
  return key.length === expected.length && timingSafeEqual(key, expected);
}
