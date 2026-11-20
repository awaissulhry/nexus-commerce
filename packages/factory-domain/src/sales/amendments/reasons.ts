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
