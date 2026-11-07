import { createHmac, randomInt, timingSafeEqual } from 'node:crypto'

/**
 * The e-mail codes of portal sign-in (B-W2b-159; PLT-050; Owner answer C3: e-mail codes only, no password, no SMS; A1
 * §3.10: invite only, a 6-digit code). One e-mail holds BOTH a link and a 6-digit code (design portal.signin code-step), so
 * a person who reads mail on a phone can still type the code on a laptop. A STEP_UP code is typed inside a signed-in
 * portal session before a sensitive act (users, roles, security).
 *
 *   lifetime   15 minutes from when it was made; 5 wrong tries kill it; using it ends it; a newer code of the same
 *              purpose replaces (revokes) it (PortalSignInCode, the …_portal_identity_w2b_guards triggers hold all of it).
 *   stored     never the code: HMAC-SHA-256 with a server key over the purpose, the tenant, the person AND what the code
 *              is bound to — the company whose portal a SIGN_IN code opens, the session a STEP_UP code was asked in — so a
 *              code typed for another company's portal or in another session matches nothing (no schema column needed:
 *              the binding is inside the hash). A plain SHA-256 of six digits would be reversed in a moment.
 *   compared   in constant time.
 */

export const PORTAL_CODE = Object.freeze({
  digits: 6,
  /** How long a code (and its link) works. The database refuses more than 15 minutes. */
  ttlMs: 15 * 60_000,
  /** Wrong codes typed before the code dies (the database's limit). */
  maxTries: 5,
  /** A new code is made at most this often per person and purpose (the page's "Send a new code in 0:42"). */
  resendAfterMs: 60_000,
  /** Dead codes are kept this long after they expired, then the purge job deletes them. */
  keepDeadMs: 24 * 60 * 60_000,
})

export type PortalCodePurpose = 'SIGN_IN' | 'STEP_UP'

/** What a code is bound to: SIGN_IN to the company whose portal it opens, STEP_UP to the session that asked. */
export interface PortalCodeBinding {
  readonly purpose: PortalCodePurpose
  readonly tenantId: string
  readonly userId: string
  /** SIGN_IN: the company's id; STEP_UP: the session's id. */
  readonly boundTo: string
}

/** A new 6-digit code, uniform over 000000–999999. `random` (tests) defaults to node:crypto's randomInt. */
export function newPortalCode(random: (min: number, max: number) => number = randomInt): string {
  const value = random(0, 10 ** PORTAL_CODE.digits)
  if (!Number.isInteger(value) || value < 0 || value >= 10 ** PORTAL_CODE.digits) throw new Error('A portal code is a whole number below 1 000 000.')
  return String(value).padStart(PORTAL_CODE.digits, '0')
}

/** The code as typed or pasted ("123 456", "123-456"), or null when it is not six digits. */
export function normalizePortalCode(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 32) return null
  const digits = value.replace(/[\s-]/g, '')
  return /^\d{6}$/.test(digits) ? digits : null
}

const CODE_HASH_PREFIX = 'pc1.'

/** What is stored for a code: `pc1.` + HMAC-SHA-256 (hex) of the binding and the code (never digits only: the guards). */
export function portalCodeHash(key: Uint8Array, binding: PortalCodeBinding, code: string): string {
  const material = ['portal-code v1', binding.purpose, binding.tenantId.toLowerCase(), binding.userId.toLowerCase(), binding.boundTo.toLowerCase(), code].join('|')
  return CODE_HASH_PREFIX + createHmac('sha256', key).update(material, 'utf8').digest('hex')
}

/** The typed code matches the stored hash for this binding (constant time; anything malformed answers no). */
export function matchesPortalCode(key: Uint8Array, binding: PortalCodeBinding, code: string | null, stored: unknown): boolean {
  if (code === null || typeof stored !== 'string' || !stored.startsWith(CODE_HASH_PREFIX)) return false
  const expected = Buffer.from(portalCodeHash(key, binding, code), 'utf8')
  const actual = Buffer.from(stored, 'utf8')
  return expected.length === actual.length && timingSafeEqual(expected, actual)
}

/** Where a code stands now: only a live code is checked; every other state is final. */
export type PortalCodeState = 'live' | 'used' | 'revoked' | 'tried_out' | 'expired'

export interface PortalCodeRow {
  readonly usedAt: Date | null
  readonly revokedAt: Date | null
  readonly tries: number
  readonly expiresAt: Date
}

export function portalCodeState(row: PortalCodeRow, now: Date): PortalCodeState {
  if (row.usedAt !== null) return 'used'
  if (row.revokedAt !== null) return 'revoked'
  if (row.tries >= PORTAL_CODE.maxTries) return 'tried_out'
  if (row.expiresAt.getTime() <= now.getTime()) return 'expired'
  return 'live'
}

/** Wrong tries left after `tries` wrong codes. */
export const portalTriesLeft = (tries: number): number => Math.max(0, PORTAL_CODE.maxTries - tries)

/** The words of a wrong or dead code (design portal.signin code-step). The same words for a known and an unknown address. */
export const PORTAL_CODE_WORDS = Object.freeze({
  wrong: (left: number) => (left === 1 ? 'That code does not match. 1 try left.' : `That code does not match. ${left} tries left.`),
  triedOut: 'Too many tries. Ask for a new code.',
  expired: 'This code has expired. We can send a new one.',
  linkDead: 'This sign-in link no longer works.',
})
