/**
 * Phase S1 (auth core) — password hashing + strength gate.
 *
 * Primary algorithm: argon2id (via @node-rs/argon2 — prebuilt native
 * binaries, no node-gyp on deploy). Parameters follow the current
 * OWASP Password Storage Cheat Sheet recommendation for argon2id
 * (m=19456 KiB, t=2, p=1). NO hand-rolled crypto: hashing, verifying,
 * and constant-time compare all come from vetted libraries.
 *
 * Legacy verification: the singleton account may still carry a bcrypt
 * ("$2…") or raw-sha256 (64 hex) hash from the pre-S1 Phase-C code
 * (see profile.routes.ts / api-key-auth.ts). verifyPassword auto-
 * detects the stored format and signals `needsRehash` so the caller
 * re-hashes to argon2id on the next successful login — the same self-
 * migrating pattern the schema already documents for sha256→bcrypt.
 */

import { hash as argonHash, verify as argonVerify, Algorithm } from '@node-rs/argon2'
import bcrypt from 'bcryptjs'
import { createHash, timingSafeEqual } from 'crypto'
import zxcvbn from 'zxcvbn'

// OWASP-recommended argon2id parameters (2024/2025 guidance).
// memoryCost is in KiB → 19456 KiB = 19 MiB.
const ARGON2ID_OPTS = {
  algorithm: Algorithm.Argon2id,
  memoryCost: 19456,
  timeCost: 2,
  parallelism: 1,
} as const

/** Minimum password length (master prompt §S1: 12 + strength gate). */
export const MIN_PASSWORD_LENGTH = 12
/** Upper bound — reject before hashing so argon2 can't be CPU-DoS'd. */
export const MAX_PASSWORD_LENGTH = 512
/** Minimum acceptable zxcvbn score (0–4). 3 = "safely unguessable". */
export const MIN_ZXCVBN_SCORE = 3

export async function hashPassword(plain: string): Promise<string> {
  return argonHash(plain, ARGON2ID_OPTS)
}

export interface VerifyPasswordResult {
  ok: boolean
  /** True when the stored hash is a legacy format and, on success,
   *  should be re-hashed to argon2id. Always false on failure. */
  needsRehash: boolean
}

/**
 * Verify a plaintext password against a stored hash of any supported
 * format. Constant-time where the primitive allows.
 */
export async function verifyPassword(
  plain: string,
  stored: string,
): Promise<VerifyPasswordResult> {
  if (!stored) return { ok: false, needsRehash: false }

  // argon2id — the current format. No rehash needed on success.
  if (stored.startsWith('$argon2')) {
    try {
      const ok = await argonVerify(stored, plain)
      return { ok, needsRehash: false }
    } catch {
      return { ok: false, needsRehash: false }
    }
  }

  // Legacy bcrypt ("$2a$" / "$2b$" / "$2y$").
  if (stored.startsWith('$2')) {
    const ok = await bcrypt.compare(plain, stored).catch(() => false)
    return { ok, needsRehash: ok }
  }

  // Legacy raw sha256 hex (64 chars). Constant-time compare.
  const hex = createHash('sha256').update(plain).digest('hex')
  if (hex.length !== stored.length) return { ok: false, needsRehash: false }
  let ok = false
  try {
    ok = timingSafeEqual(Buffer.from(hex), Buffer.from(stored))
  } catch {
    ok = false
  }
  return { ok, needsRehash: ok }
}

export interface StrengthResult {
  ok: boolean
  /** zxcvbn score 0–4. */
  score: number
  /** Human-readable reason when ok=false (safe to surface to the user). */
  message?: string
}

/**
 * Enforce the strength policy: length floor + zxcvbn score floor.
 * `userInputs` (email, display name) are fed to zxcvbn so a password
 * derived from the account identity is penalised.
 */
export function checkPasswordStrength(
  plain: string,
  userInputs: string[] = [],
): StrengthResult {
  if (typeof plain !== 'string' || plain.length < MIN_PASSWORD_LENGTH) {
    return {
      ok: false,
      score: 0,
      message: `Password must be at least ${MIN_PASSWORD_LENGTH} characters.`,
    }
  }
  if (plain.length > MAX_PASSWORD_LENGTH) {
    return { ok: false, score: 0, message: `Password must be at most ${MAX_PASSWORD_LENGTH} characters.` }
  }
  // zxcvbn caps analysis at 100 chars; guard against DoS on huge inputs.
  const sample = plain.slice(0, 100)
  const result = zxcvbn(sample, userInputs.filter(Boolean))
  if (result.score < MIN_ZXCVBN_SCORE) {
    const suggestion =
      result.feedback?.warning ||
      result.feedback?.suggestions?.[0] ||
      'Choose a longer passphrase with unrelated words.'
    return { ok: false, score: result.score, message: suggestion }
  }
  return { ok: true, score: result.score }
}
