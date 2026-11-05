import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto'

/**
 * The self-hosted proof-of-work check of the public routes (B-W2b-159; PLT-066 "Bot and brute-force protection on public
 * pages"; design portal.signin "A CAPTCHA appears only after suspicious traffic, never by default", links.frame ask-new-link;
 * GATE-SPEND: no third party, no cost). Asked only after suspicious traffic from one network (abuse/policies.ts): the page
 * then spends a moment of the visitor's processor before its request counts, which costs a person nothing and makes a
 * script that sends thousands of requests slow and expensive. No image to read, no outside service, nothing about the
 * person is sent anywhere.
 *
 *   challenge  `pw1.<policy>.<issued at, ms, base 36>.<bits>.<salt>.<mac>` — stateless: the server's HMAC over the
 *              policy, the time, the difficulty, a random salt and the network it was issued to (the hashed address), so
 *              a challenge cannot be made up, changed, carried to another network or used past its 5 minutes;
 *   solution   a nonce (1 to 32 letters or digits) such that SHA-256 of `<challenge>:<nonce>` (UTF-8, as bytes) starts
 *              with `bits` zero bits. On average 2^bits hashes: 2^15 ≈ 33 000, a fraction of a second in a browser's
 *              WebCrypto; the server checks it with ONE hash;
 *   once       the API claims each solved challenge's salt once (abuse store): a solution is not replayed.
 */

export const POW = Object.freeze({
  version: 'pw1',
  /** A challenge is answered within this long. */
  ttlMs: 5 * 60_000,
  minBits: 8,
  maxBits: 24,
  algorithm: 'sha256-leading-zero-bits' as const,
})

const NONCE = /^[A-Za-z0-9]{1,32}$/
const POLICY = /^[a-z][a-z0-9.-]{0,63}$/
const SALT_BYTES = 16

export interface Challenge {
  readonly value: string
  readonly policy: string
  readonly bits: number
  readonly issuedAt: Date
  readonly expiresAt: Date
  /** The salt: what the API claims once when the challenge is solved. */
  readonly salt: string
}

function macOf(key: Uint8Array, payload: string, subject: string): string {
  return createHmac('sha256', key).update(`${payload}|${subject}`, 'utf8').digest('base64url')
}

/** A new challenge for a policy and the hashed network that asked. `random` (tests) defaults to randomBytes. */
export function issueChallenge(
  key: Uint8Array,
  input: { readonly policy: string; readonly bits: number; readonly subject: string; readonly now: Date },
  random: (size: number) => Uint8Array = randomBytes,
): Challenge {
  if (!POLICY.test(input.policy)) throw new Error('A challenge names a policy like portal.signin.start.')
  const bits = Math.min(POW.maxBits, Math.max(POW.minBits, Math.round(input.bits)))
  const salt = Buffer.from(random(SALT_BYTES)).toString('base64url')
  const issued = input.now.getTime()
  const payload = [POW.version, input.policy, issued.toString(36), String(bits), salt].join('.')
  return { value: `${payload}.${macOf(key, payload, input.subject)}`, policy: input.policy, bits, issuedAt: input.now, expiresAt: new Date(issued + POW.ttlMs), salt }
}

/** True when SHA-256(`<challenge>:<nonce>`) starts with `bits` zero bits. */
export function meetsDifficulty(challenge: string, nonce: string, bits: number): boolean {
  const digest = createHash('sha256').update(`${challenge}:${nonce}`, 'utf8').digest()
  let left = bits
  for (const byte of digest) {
    if (left <= 0) return true
    if (left >= 8) {
      if (byte !== 0) return false
      left -= 8
    } else {
      return byte >> (8 - left) === 0
    }
  }
  return left <= 0
}

export type ProofVerdict =
  | { readonly ok: true; readonly salt: string; readonly bits: number }
  | { readonly ok: false; readonly reason: 'malformed' | 'forged' | 'other_policy' | 'expired' | 'too_easy' | 'unsolved' }

/**
 * Checks a solved challenge: well formed, made by this server for this policy and this network, not expired, at least
 * `minBits` hard, and solved. The caller claims `salt` once before it lets the request count.
 */
export function verifyProof(
  key: Uint8Array,
  proof: { readonly challenge: unknown; readonly nonce: unknown },
  expected: { readonly policy: string; readonly subject: string; readonly minBits: number; readonly now: Date },
): ProofVerdict {
  const { challenge, nonce } = proof
  if (typeof challenge !== 'string' || typeof nonce !== 'string' || challenge.length > 200 || !NONCE.test(nonce)) return { ok: false, reason: 'malformed' }
  const parts = challenge.split('.')
  const mac = parts.pop()
  const [version, ...rest] = parts
  // The policy itself holds dots: version . policy… . issued . bits . salt
  if (version !== POW.version || rest.length < 4 || mac === undefined) return { ok: false, reason: 'malformed' }
  const salt = rest.pop()!
  const bitsText = rest.pop()!
  const issuedText = rest.pop()!
  const policy = rest.join('.')
  const bits = Number(bitsText)
  const issued = parseInt(issuedText, 36)
  if (!POLICY.test(policy) || !Number.isInteger(bits) || !Number.isFinite(issued) || !/^[A-Za-z0-9_-]{22}$/.test(salt)) return { ok: false, reason: 'malformed' }
  const payload = [version, policy, issuedText, bitsText, salt].join('.')
  const wanted = Buffer.from(macOf(key, payload, expected.subject), 'utf8')
  const given = Buffer.from(mac, 'utf8')
  if (wanted.length !== given.length || !timingSafeEqual(wanted, given)) return { ok: false, reason: 'forged' }
  if (policy !== expected.policy) return { ok: false, reason: 'other_policy' }
  const now = expected.now.getTime()
  if (issued > now + 60_000 || issued + POW.ttlMs <= now) return { ok: false, reason: 'expired' }
  if (bits < expected.minBits) return { ok: false, reason: 'too_easy' }
  if (!meetsDifficulty(challenge, nonce, bits)) return { ok: false, reason: 'unsolved' }
  return { ok: true, salt, bits }
}

/**
 * Solves a challenge (tests, scripts and the reference for the web, which does the same with WebCrypto): tries nonces
 * 0, 1, 2 … in base 36 until one meets the difficulty. Gives up after `limit` tries (null).
 */
export function solveChallenge(challenge: string, bits: number, limit = 1 << 26): string | null {
  for (let attempt = 0; attempt < limit; attempt++) {
    const nonce = attempt.toString(36)
    if (meetsDifficulty(challenge, nonce, bits)) return nonce
  }
  return null
}
