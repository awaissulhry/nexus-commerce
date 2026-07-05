/**
 * F1 — password hashing on node:crypto scrypt (zero native deps; parameters
 * per OWASP: N=2^15, r=8, p=1, 32-byte key). Wire: `scrypt:<salt_hex>:<hash_hex>`.
 */
import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";

const N = 2 ** 15;
const OPTS = { N, r: 8, p: 1, maxmem: 128 * N * 8 * 2 };

export function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, 32, OPTS);
  return `scrypt:${salt.toString("hex")}:${hash.toString("hex")}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const [scheme, saltHex, hashHex] = stored.split(":");
  if (scheme !== "scrypt" || !saltHex || !hashHex) return false;
  const expected = Buffer.from(hashHex, "hex");
  const actual = scryptSync(password, Buffer.from(saltHex, "hex"), expected.length, OPTS);
  return timingSafeEqual(actual, expected);
}
