import type { TaskSource } from '../../portal/tasks/sources'

/**
 * B-W2b-177 (COL-049; plan: "for a partner's file, the partner (a PartnerTask UPLOAD_DOCUMENT) 30 and 7 days before"): when a
 * document the office shares with a partner (visibility PARTNER, its party) comes within 30 days of its expiry date, the
 * expiry reminder (./remind.ts) asks the partner for a new version in the same command. sourceKey
 * `Expiry:<series' first version>:<expiry date>`: one request per document and date (the 7-day reminder finds the 30-day
 * one). The partner answers by sending a new version; the request closes (DONE, by the office's side) once the series'
 * current version is valid beyond the reminders — a later date typed on it, or no date (./answered.ts: at the date's change
 * and at every reminder pass). The partner does not mark it done by hand: only the new document answers it.
 *
 * This file holds the declaration only (portal/tasks/sources imports it; the commands that open and close live beside it).
 */
export const EXPIRY_SOURCE: TaskSource = Object.freeze({ name: 'files.expiry', prefix: 'Expiry', kinds: ['UPLOAD_DOCUMENT'] as const, partnerDone: false })

/** The request's key for a document's series and expiry date. */
export const expirySourceKey = (root: string, expiresOn: string): string => `${EXPIRY_SOURCE.prefix}:${root}:${expiresOn}`

/** The series and the date of an expiry request's key, or null for another source's. */
export function expiryKeyParts(sourceKey: string): { readonly root: string; readonly expiresOn: string } | null {
  const match = /^Expiry:([0-9a-f-]{36}):(\d{4}-\d{2}-\d{2})$/.exec(sourceKey)
  return match ? { root: match[1]!, expiresOn: match[2]! } : null
}
