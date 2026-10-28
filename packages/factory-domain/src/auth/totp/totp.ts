/**
 * TOTP two-factor rules (plan A1 §3.10; features PLT-048, PLT-063), ported from Commerce (apps/api/src/lib/auth/mfa.ts
 * and step-up.ts): 6-digit codes of 30 seconds (RFC 6238, SHA-1, what every authenticator app reads from the QR), one
 * step of clock drift either way, and each code used once: a code is accepted only for a time step AFTER the last
 * accepted one, so a code seen over a shoulder or replayed from a log opens nothing, at sign-in or at a step-up.
 * Recovery codes: ten, shown once, each used once.
 *
 * Pure: the code of a time step comes from the caller (`codeAt`; the API computes it with otplib from the secret),
 * random bytes come in as an argument, the time comes in as a Date.
 */

export const TOTP = Object.freeze({
  digits: 6,
  periodSeconds: 30,
  /** Time steps of drift accepted either way (±30 s). */
  window: 1,
  algorithm: 'SHA1' as const,
})

/** The RFC 6238 time step (counter) of an instant. */
export function timeStepAt(instant: Date): number {
  return Math.floor(instant.getTime() / 1000 / TOTP.periodSeconds)
}

/** The code the person typed, spaces removed, when it has the shape of a TOTP code (6 digits); otherwise null. */
export function totpCodeOf(input: unknown): string | null {
  if (typeof input !== 'string') return null
  const code = input.replace(/\s+/g, '')
  return /^\d{6}$/.test(code) ? code : null
}

/** Compares two short codes without stopping at the first difference. */
function sameCode(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let difference = 0
  for (let index = 0; index < a.length; index++) difference |= a.charCodeAt(index) ^ b.charCodeAt(index)
  return difference === 0
}

/** The code of a time step for one secret (the API's otplib adapter). */
export type CodeAt = (step: number) => string

export type TotpVerdict =
  | { readonly ok: true; readonly step: number }
  | { readonly ok: false; readonly reason: 'malformed' | 'wrong' | 'replayed' }

export interface TotpCheck {
  readonly code: unknown
  readonly now: Date
  /** The step of the last code accepted for this secret, or null when none was. */
  readonly lastStep: number | null
  readonly codeAt: CodeAt
}

/**
 * Checks a code against the steps around now. Accepts the code of a step after `lastStep` (the caller stores the
 * returned step as the new last one, compare-and-set); a code that only matches `lastStep` or an earlier step is
 * `replayed`. Every step of the window is computed and compared, whatever matched.
 */
export function checkTotpCode({ code, now, lastStep, codeAt }: TotpCheck): TotpVerdict {
  const typed = totpCodeOf(code)
  if (typed === null) return { ok: false, reason: 'malformed' }
  const current = timeStepAt(now)
  let accepted: number | null = null
  let replayed = false
  for (let step = current - TOTP.window; step <= current + TOTP.window; step++) {
    const matches = sameCode(codeAt(step), typed)
    if (!matches) continue
    if (lastStep !== null && step <= lastStep) replayed = true
    else if (accepted === null) accepted = step
  }
  if (accepted !== null) return { ok: true, step: accepted }
  return { ok: false, reason: replayed ? 'replayed' : 'wrong' }
}

/** Recovery codes (PLT-048): ten codes of ten characters, shown once as `XXXXX-XXXXX`, 50 random bits each. */
export const RECOVERY_CODES = Object.freeze({
  count: 10,
  length: 10,
  /** No 0/O, 1/I/L: easy to read back from paper. */
  alphabet: 'ABCDEFGHJKMNPQRSTUVWXYZ23456789',
})

/**
 * One recovery code from random bytes (at least `length` of them). The alphabet has 31 letters, so each byte maps
 * through `byte % 31`; the small bias (256 is not a multiple of 31) costs well under a bit per code.
 */
export function recoveryCodeFrom(random: Uint8Array): string {
  if (random.length < RECOVERY_CODES.length) throw new Error(`A recovery code needs ${RECOVERY_CODES.length} random bytes.`)
  let code = ''
  for (let index = 0; index < RECOVERY_CODES.length; index++) code += RECOVERY_CODES.alphabet[random[index]! % RECOVERY_CODES.alphabet.length]
  return `${code.slice(0, 5)}-${code.slice(5)}`
}

/**
 * A typed recovery code in its stored form (upper case, no spaces or hyphens), or null when it cannot be one. The
 * stored form is what gets hashed, so `abcde fghjk` and `ABCDE-FGHJK` are the same code.
 */
export function recoveryCodeOf(input: unknown): string | null {
  if (typeof input !== 'string') return null
  const code = input.replace(/[\s-]+/g, '').toUpperCase()
  if (code.length !== RECOVERY_CODES.length) return null
  for (const char of code) if (!RECOVERY_CODES.alphabet.includes(char)) return null
  return code
}
