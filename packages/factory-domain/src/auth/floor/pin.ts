import { createHmac, hkdfSync, randomInt } from 'node:crypto'
import type { Issue } from '../../core/errors'
import { hashPassword, SCRYPT_PARAMS, verifyPassword, type PasswordCheck, type ScryptParams } from '../password/password'

/**
 * Floor PINs (plan A1 §3.10 "Floor"; features PLT-057, PLT-058): what a PIN must be, how it is stored, and the lock a
 * run of wrong ones sets. A PIN works only on an enrolled device (the device is the "something you have"), so six
 * digits are enough; trivial ones are refused because a colleague would guess them first.
 *
 *   policy    exactly 6 digits; not one digit repeated (000000), not a straight run up or down (123456, 987654), not
 *             a repeated pair or triple (121212, 123123), not a mirror (123321), not a well-known PIN, not the
 *             worker's own employee number.
 *   storage   peppered, then scrypt: HMAC-SHA-256 of the PIN with a server-side pepper (FACTORY_PIN_PEPPER, never in
 *             the database), then scrypt with a per-PIN random salt in the self-describing form of office passwords
 *             (../password). A million six-digit PINs are guessed in minutes against a plain scrypt hash; without the
 *             pepper a leaked hash cannot be guessed at all. Stored as `$pin$<pepper id>$scrypt$ln=…`: the id names
 *             the pepper, so a new pepper can take over (FACTORY_PIN_PEPPER_PREVIOUS still opens the older hashes,
 *             and a sign-in re-hashes them with the new one). The verify takes the same time with or without a
 *             stored PIN.
 *   lockout   5 wrong PINs in a row lock THAT worker (never the device: the next person can sign in) for 5 minutes,
 *             every further wrong one doubles the lock, up to an hour. While locked even the right PIN opens
 *             nothing. A successful sign-in or an administrator's PIN reset clears the count.
 * Pure: the count comes from the database (incremented there, atomically), the time comes in.
 */

export const PIN_LENGTH = 6

export const PIN_LOCKOUT = Object.freeze({
  maxFailures: 5,
  firstLockMs: 5 * 60_000,
  maxLockMs: 60 * 60_000,
})

/** Well-known six-digit PINs the rules below do not already catch (public top lists of leaked PINs). */
const COMMON = new Set(['112233', '159753', '147258', '258369', '159357', '147852', '789456', '123654', '102030', '201020', '696969', '010203', '100200', '111222', '998877', '778899', '445566', '332211'])

const DIGITS = /^\d+$/

export interface PinContext {
  /** The worker's employee number: a PIN equal to it is refused. */
  readonly employeeCode?: string | null | undefined
}

/** A straight run with one step: 123456, 345678, 987654, 890123 (wrapping past 9 counts too). */
function isRun(pin: string): boolean {
  const steps = new Set<number>()
  for (let index = 1; index < pin.length; index++) steps.add((Number(pin[index]) - Number(pin[index - 1]) + 10) % 10)
  return steps.size === 1 && (steps.has(1) || steps.has(9))
}

/** The same block over and over: 121212, 123123. */
function isRepeat(pin: string): boolean {
  for (const size of [1, 2, 3]) {
    const block = pin.slice(0, size)
    if (block.repeat(pin.length / size) === pin) return true
  }
  return false
}

/** What is wrong with a new PIN, as issues at `pin` (empty: it is accepted). The message is for the person. */
export function pinProblems(pin: unknown, context: PinContext = {}): Issue[] {
  const at = (message: string): Issue[] => [{ path: 'pin', message }]
  if (typeof pin !== 'string' || pin.length !== PIN_LENGTH || !DIGITS.test(pin)) return at(`Enter exactly ${PIN_LENGTH} digits.`)
  if (isRepeat(pin)) return at('Do not repeat the same digits; choose another PIN.')
  if (isRun(pin)) return at('Do not use digits in a row (like 123456); choose another PIN.')
  if (pin === [...pin].reverse().join('')) return at('Do not use a PIN that reads the same both ways; choose another.')
  if (COMMON.has(pin)) return at('This PIN is too common; choose another.')
  const employeeCode = context.employeeCode?.replace(/\D/g, '') ?? ''
  if (employeeCode.length >= 4 && (pin === employeeCode || employeeCode.endsWith(pin) || pin.endsWith(employeeCode))) {
    return at('Do not use your employee number as your PIN.')
  }
  return []
}

/** A pepper: the HMAC key derived from a configured secret, and its id (stored with every hash it made). */
export interface PinPepper {
  readonly id: string
  readonly key: Buffer
}

/** The peppers the API holds: the current one makes every new hash; previous ones still open older hashes. */
export interface PinKeyring {
  readonly current: PinPepper
  readonly previous: readonly PinPepper[]
}

/** The minimum length of a configured pepper secret in staging and production. */
export const PIN_PEPPER_MIN_LENGTH = 32

/**
 * The pepper of a configured secret: an HMAC key derived with HKDF-SHA-256, and an id that names it without revealing
 * it (`p` + 12 hex characters of an HMAC of a fixed label).
 */
export function pinPepper(secret: string): PinPepper {
  if (typeof secret !== 'string' || secret.length < 16) throw new Error('The PIN pepper is too short.')
  const key = Buffer.from(hkdfSync('sha256', secret, 'nexus-factory-pin', 'pin-pepper v1', 32))
  const id = `p${createHmac('sha256', key).update('factory pin pepper id v1').digest('hex').slice(0, 12)}`
  return { id, key }
}

/** The keyring of the configured current secret and any previous ones (rotation). */
export function pinKeyring(current: string, previous: readonly string[] = []): PinKeyring {
  const peppers = previous.map(pinPepper)
  const head = pinPepper(current)
  return Object.freeze({ current: head, previous: Object.freeze(peppers.filter((pepper) => pepper.id !== head.id)) })
}

const STORED = /^\$pin\$(p[0-9a-f]{12})\$(\$scrypt\$.+)$/

/** What scrypt hashes: the PIN's HMAC with the pepper, never the PIN. */
const peppered = (pin: string, pepper: PinPepper): string => createHmac('sha256', pepper.key).update(`factory-pin\u0000${pin}`, 'utf8').digest('base64url')

const isPin = (pin: unknown): pin is string => typeof pin === 'string' && pin.length === PIN_LENGTH && DIGITS.test(pin)

/**
 * The stored form of a new PIN, with the keyring's current pepper (check `pinProblems` first; this refuses anything
 * that is not 6 digits). `params` only for tests (a cheaper scrypt; a sign-in re-hashes it).
 */
export async function hashPin(pin: string, keyring: PinKeyring, params: ScryptParams = SCRYPT_PARAMS): Promise<string> {
  if (!isPin(pin)) throw new Error('A PIN is exactly 6 digits.')
  return `$pin$${keyring.current.id}$${await hashPassword(peppered(pin, keyring.current), params)}`
}

/**
 * Checks a PIN against its stored form in constant time. Without a stored PIN (none set, a damaged row, a pepper the
 * keyring does not hold) or with input that is not a PIN it still runs one scrypt, so the answer takes the same time;
 * then it answers no. `needsRehash`: the hash was made with a previous pepper or older scrypt settings; store a new
 * one after the successful check.
 */
export async function verifyPin(pin: unknown, stored: string | null | undefined, keyring: PinKeyring): Promise<PasswordCheck> {
  const match = typeof stored === 'string' ? STORED.exec(stored) : null
  const pepper = match ? [keyring.current, ...keyring.previous].find((entry) => entry.id === match[1]) : undefined
  if (!isPin(pin) || !match || !pepper) {
    await verifyPassword(peppered('000000', keyring.current), null)
    return { ok: false, needsRehash: false }
  }
  const check = await verifyPassword(peppered(pin, pepper), match[2])
  return { ok: check.ok, needsRehash: check.ok && (check.needsRehash || pepper.id !== keyring.current.id) }
}

/** A random PIN that passes the policy (an administrator's reset hands it to the worker once). */
export function randomPin(context: PinContext = {}): string {
  for (;;) {
    const pin = String(randomInt(0, 10 ** PIN_LENGTH)).padStart(PIN_LENGTH, '0')
    if (pinProblems(pin, context).length === 0) return pin
  }
}

/** How long the worker locks once they have this many wrong PINs in a row (0 below the threshold). */
export function pinLockMsAfter(failedAttempts: number): number {
  if (!Number.isInteger(failedAttempts) || failedAttempts < PIN_LOCKOUT.maxFailures) return 0
  const over = failedAttempts - PIN_LOCKOUT.maxFailures
  return Math.min(PIN_LOCKOUT.firstLockMs * 2 ** Math.min(over, 30), PIN_LOCKOUT.maxLockMs)
}

/** The lock set by the latest wrong PIN: until when, or null below the threshold. */
export function pinLockUntil(failedAttempts: number, now: Date): Date | null {
  const ms = pinLockMsAfter(failedAttempts)
  return ms === 0 ? null : new Date(now.getTime() + ms)
}

/** True while the worker is locked. */
export function isPinLocked(state: { readonly pinLockedUntil: Date | null }, now: Date): boolean {
  return state.pinLockedUntil !== null && state.pinLockedUntil.getTime() > now.getTime()
}
