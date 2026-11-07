import { createHmac, timingSafeEqual } from 'node:crypto'
import { isUuid } from '../core/ids'

/**
 * The password of a link (COL-051, MES-274; design links.document and links.file "Password": "optional password sent
 * separately; 5 tries, then held 15 minutes"). Only a DOCUMENT_VIEW or SECURE_FILE link takes one (links/purposes
 * `password`). The office types it when it makes the link and tells it to the person another way (a call, a message):
 * the link's mail never holds it. Stored as its scrypt hash only (auth/password hashPassword; the database refuses
 * anything else), never shown again, never readable by the link's own session (the partner role's grant hides it).
 *
 *   tries     a wrong password counts one try on the link (OneOffLink.passwordTries); the fifth holds the link for 15
 *             minutes (passwordHeldUntil): while held, nothing is checked and nothing moves. After the hold a wrong one
 *             counts 1 again; a right one sets the count back to 0. The count is the link's, whoever types: a holder
 *             cannot guess past five every quarter of an hour (the database keeps the same rules).
 *   unlock    a right password opens the link's files for 30 minutes (never past the link's expiry): the answer carries
 *             an unlock key `lu1.<linkId>.<untilMs>.<mac>` (HMAC-SHA-256 with the API's own key) that the page sends with
 *             each read of the files (header x-factory-link-unlock). It holds no password and opens nothing without the
 *             link's own token.
 */

export const LINK_PASSWORD = Object.freeze({
  minLength: 8,
  maxLength: 128,
  /** Wrong passwords before the hold. */
  tries: 5,
  holdMs: 15 * 60 * 1000,
  /** How long a right password opens the files. */
  unlockMs: 30 * 60 * 1000,
})

/** What is wrong with a password the office gives a link, or null (as typed: never trimmed, never changed). */
export function linkPasswordProblem(password: unknown): string | null {
  if (typeof password !== 'string') return 'Type a password.'
  const length = [...password].length
  if (length < LINK_PASSWORD.minLength || length > LINK_PASSWORD.maxLength) return `A link password has ${LINK_PASSWORD.minLength} to ${LINK_PASSWORD.maxLength} characters.`
  if (password.trim() === '') return 'A link password is more than spaces.'
  if (/[\u0000-\u001f\u007f]/u.test(password)) return 'The password holds a character that cannot be typed.'
  return null
}

export interface PasswordState {
  readonly tries: number
  readonly heldUntil: Date | null
}

export type PasswordStep =
  /** Held after five wrong ones: nothing is checked, nothing is written. */
  | { readonly kind: 'held'; readonly until: Date }
  /** Right: `next` is what to write (null: nothing, the count is already 0). */
  | { readonly kind: 'right'; readonly next: PasswordState | null }
  /** Wrong: always written; `triesLeft` 0 means the link is now held until `next.heldUntil`. */
  | { readonly kind: 'wrong'; readonly next: PasswordState; readonly triesLeft: number }

/** Held now? (a hold that passed is not). */
export const passwordHeld = (state: PasswordState, now: Date): boolean => state.heldUntil !== null && now.getTime() < state.heldUntil.getTime()

/** What a typed password does to the link's count (see above). `right` is the outcome of the scrypt check. */
export function passwordStep(state: PasswordState, right: boolean, now: Date): PasswordStep {
  if (passwordHeld(state, now)) return { kind: 'held', until: state.heldUntil! }
  if (right) return { kind: 'right', next: state.tries === 0 && state.heldUntil === null ? null : { tries: 0, heldUntil: null } }
  const tries = state.tries >= LINK_PASSWORD.tries ? 1 : state.tries + 1
  const heldUntil = tries === LINK_PASSWORD.tries ? new Date(now.getTime() + LINK_PASSWORD.holdMs) : null
  return { kind: 'wrong', next: { tries, heldUntil }, triesLeft: LINK_PASSWORD.tries - tries }
}

/** The words of a wrong or held password. */
export function passwordWords(step: Exclude<PasswordStep, { kind: 'right' }>, now: Date): string {
  if (step.kind === 'wrong' && step.triesLeft > 0) return `That password does not match. ${step.triesLeft} ${step.triesLeft === 1 ? 'try' : 'tries'} left.`
  const until = step.kind === 'held' ? step.until : step.next.heldUntil!
  const minutes = Math.max(1, Math.ceil((until.getTime() - now.getTime()) / 60_000))
  return `Too many wrong passwords. Try again in ${minutes} ${minutes === 1 ? 'minute' : 'minutes'}, or ask the sender.`
}

// ---- the unlock key ---------------------------------------------------------------------------------------------------

const UNLOCK = /^lu1\.([0-9a-f-]{36})\.(\d{13})\.([A-Za-z0-9_-]{43})$/

const mac = (key: Uint8Array, linkId: string, untilMs: number): Buffer => createHmac('sha256', key).update(`link-unlock|${linkId}|${untilMs}`, 'utf8').digest()

/** The unlock key of a link after a right password, and until when it opens its files. */
export function mintUnlock(key: Uint8Array, linkId: string, now: Date, linkExpiresAt: Date): { readonly value: string; readonly until: Date } {
  if (!isUuid(linkId)) throw new Error('An unlock key names a link id.')
  const untilMs = Math.min(now.getTime() + LINK_PASSWORD.unlockMs, linkExpiresAt.getTime())
  return { value: `lu1.${linkId.toLowerCase()}.${untilMs}.${mac(key, linkId.toLowerCase(), untilMs).toString('base64url')}`, until: new Date(untilMs) }
}

/** The unlock key opens this link now (constant-time compare; anything malformed, expired or another link's: no). */
export function unlockOpens(key: Uint8Array, value: unknown, linkId: string, now: Date): boolean {
  if (typeof value !== 'string') return false
  const match = UNLOCK.exec(value.trim())
  if (!match || match[1] !== linkId.toLowerCase()) return false
  const untilMs = Number(match[2])
  if (!Number.isSafeInteger(untilMs) || untilMs <= now.getTime()) return false
  const given = Buffer.from(match[3]!, 'base64url')
  const expected = mac(key, match[1]!, untilMs)
  return given.length === expected.length && timingSafeEqual(given, expected)
}
