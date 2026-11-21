/**
 * B-OL-004 (order lines plan D2; 18 F22, F23): a reason is optional — the server writes automatic words when none is given.
 *
 * The database keeps a reason on every amendment, closed line and promise move, so when the office gives none the server stores
 * the act's automatic words: one constant per act, stored in English as they are. The screen translates them and adds "by {name}"
 * from the audit row's actor; the customer never reads them (the re-acceptance page leaves an automatic reason out, the portal's
 * promise history shows no reason for it). A reason the office types is stored as typed. Pure.
 */
export const AUTOMATIC_REASONS = Object.freeze({
  amend: 'Changed on the order page.',
  close: 'Closed on the order page.',
  reopen: 'Reopened on the order page.',
  promise: 'Date changed on the order page.',
} as const)
export type AutomaticReasonKind = keyof typeof AUTOMATIC_REASONS

/** The reason stored for an act: the words typed (trimmed), else the act's automatic words. */
export function reasonOr(kind: AutomaticReasonKind, typed: string | null | undefined): string {
  const words = typeof typed === 'string' ? typed.trim() : ''
  return words === '' ? AUTOMATIC_REASONS[kind] : words
}

/** The stored reason is one of the automatic words (nobody typed one). */
export const isAutomaticReason = (reason: string | null | undefined): boolean => typeof reason === 'string' && (Object.values(AUTOMATIC_REASONS) as string[]).includes(reason.trim())

// ── B-OC-012 (order changes tab R8; 13-backend §4): the words the server writes for a change nobody typed a reason for, and the ONE
// recognizer that reads them back — no column: the reason stays as stored, and the writers build their words from the templates
// below, so the recognizer and the writers share one source. ──
export const SERVER_REASON_CODES = ['AUTOMATIC', 'REQUEST', 'PUT_BACK'] as const
export type ServerReasonCode = (typeof SERVER_REASON_CODES)[number]

/** The customer's request an accepted change carries out, as the office's amendment keeps it when nobody typed a reason. */
export interface RequestReasonFacts {
  readonly kind: string
  /** A cancel request's reason code (its words in the portal's list). */
  readonly reasonCode: string | null
  /** The day it was asked (YYYY-MM-DD). */
  readonly askedOn: string
  /** The customer's own words with it, if any. */
  readonly reason: string | null
}

/** The amendment of an accepted customer request with no typed reason (sales/change-requests office.ts reasonOf). */
export function requestReasonWords(request: RequestReasonFacts): string {
  const what = request.kind === 'CANCEL' ? `cancel request (${request.reasonCode})` : 'change request'
  return `The customer's ${what} of ${request.askedOn} from the portal${request.reason ? `: ${request.reason}` : ''}`
}

/**
 * Why a change was put back as it was (sales/order-changes changes.ts putBackChange): our yes refused, or the customer's no —
 * B-OC-013 (order changes tab R9; Owner D5 2026-11-22): or the customer's silence (its ask expired: silence is not a yes).
 */
export const PUT_BACK_CAUSES = ['YES_REFUSED', 'CUSTOMER_REFUSED', /* B-OC-013 */ 'CUSTOMER_SILENT'] as const
export type PutBackCause = (typeof PUT_BACK_CAUSES)[number]
const PUT_BACK_CAUSE_WORDS: Readonly<Record<PutBackCause, string>> = Object.freeze({
  YES_REFUSED: 'its yes was refused',
  CUSTOMER_REFUSED: 'the customer refused it',
  CUSTOMER_SILENT: 'the customer did not answer in time', // B-OC-013
})

/** The put-back's own amendment, with no typed reason: "Put back as before revision 2: the customer refused it." */
export const putBackReasonWords = (revision: number, cause: PutBackCause): string => `Put back as before revision ${revision}: ${PUT_BACK_CAUSE_WORDS[cause]}.`

const REQUEST_REASON = /^The customer's (?:change request|cancel request \([^)]*\)) of \d{4}-\d{2}-\d{2} from the portal(?::|$)/
const PUT_BACK_REASON = /^Put back as before revision \d+: /

/** Which server words a stored reason is (AUTOMATIC · REQUEST · PUT_BACK), or null: typed by a person (or none). Pure. */
export function serverReasonOf(reason: string | null | undefined): ServerReasonCode | null {
  if (typeof reason !== 'string') return null
  if (isAutomaticReason(reason)) return 'AUTOMATIC'
  const text = reason.trim()
  if (REQUEST_REASON.test(text)) return 'REQUEST'
  if (PUT_BACK_REASON.test(text)) return 'PUT_BACK'
  return null
}
// ── end B-OC-012 ──
