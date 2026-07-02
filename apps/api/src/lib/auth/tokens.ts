/**
 * Phase S1 (auth core) — opaque token generation + hashing.
 *
 * One place for every secret token the auth system mints: session
 * cookies, invitation links, password-reset links. The pattern is
 * identical everywhere and deliberately boring:
 *   • raw token  = 256 bits of CSPRNG, base64url — shown to the user
 *     (in a cookie / link) exactly once, never stored.
 *   • stored     = sha256(raw) hex — what lands in the DB. A DB read
 *     cannot reverse it into a working token.
 *   • compare    = constant-time over the hashes.
 *
 * sha256 (not bcrypt/argon2) is correct here: these tokens are high-
 * entropy random values, not human passwords, so there is nothing to
 * brute-force and no need for a slow KDF. Vetted primitives only.
 */

import { randomBytes, createHash, timingSafeEqual } from 'crypto'

/** Generate a raw opaque token: `bytes` of CSPRNG as base64url. */
export function generateToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url')
}

/** sha256 hex of a raw token — the value stored in the DB. */
export function hashToken(raw: string): string {
  return createHash('sha256').update(raw).digest('hex')
}

/** First 8 chars of the hash, for display/debug (non-secret). */
export function tokenPrefix(rawOrHash: string): string {
  return hashToken(rawOrHash).slice(0, 8)
}

/** Constant-time compare of two hex strings of equal length. */
export function constantTimeEqualHex(a: string, b: string): boolean {
  if (typeof a !== 'string' || typeof b !== 'string') return false
  if (a.length !== b.length || a.length === 0) return false
  try {
    return timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'))
  } catch {
    return false
  }
}
