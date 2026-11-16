import type { Issue } from '../../core/errors'

/**
 * Erasure and anonymisation with the law's exceptions (B-W2b-405; PLT-203; GDPR art. 17(1), 17(3)(b), (e); c.c. art. 2220; DPR
 * 633/72 art. 39; D.Lgs. 81/2008 art. 25; design admin.privacy "Anonymise …?": what is erased, what stays because the law requires
 * it, the decision is logged, a typed name). Always a person's decision on an ERASURE request, with a reason and a fresh code;
 * legal holds win over erasure (fiscal documents, open disputes, safety reports, employment and health records).
 *
 * What one record gets, written as one ErasureRecord (column names, never values):
 *   ANONYMISED  the person's columns are blanked or replaced; the rest of the record (the business data) stays
 *   DELETED     the record is gone (a personal custom value; B-W2b-GF1: a file attached to what the person sent, its row DELETED)
 *   KEPT        the record stays as it is, with why (a legal hold)
 * A record that keeps some personal columns names them with why (keptFields). B-W2b-GF1 (the Owner's decision of 15 Nov 2026):
 * a received mail no longer keeps its envelope sender (it was IMMUTABLE): every column of the person in it is blanked.
 */

export const KEPT_WHY = ['FISCAL', 'DISPUTE', 'SAFETY_REPORT', 'EMPLOYMENT', 'HEALTH', 'CUSTOMER', 'MEASUREMENTS', 'ALREADY_ERASED', 'NOTICE_PROOF', 'LEGAL_HOLD', 'RETAINED'] as const
export type KeptWhy = (typeof KEPT_WHY)[number]

/** The words stored as ErasureRecord.keptWhy (3-1000 characters): what the law keeps and why. */
export const KEPT_WHY_WORDS: Readonly<Record<KeptWhy, string>> = Object.freeze({
  FISCAL: 'Kept: fiscal and accounting records are kept 10 years (c.c. art. 2220; DPR 633/72 art. 39; GDPR art. 17(3)(b)).',
  DISPUTE: 'Kept while a dispute is open (a complaint, a return, a service case or a labour dispute): the details are needed to settle it (GDPR art. 17(3)(e)).',
  SAFETY_REPORT: 'Kept while the product-safety report is being assessed: the maker may need to reach the reporter (Reg. (EU) 2023/988 arts. 9, 20; GDPR art. 17(3)(b)).',
  EMPLOYMENT: 'Kept: employment records are kept 5 years after the employment ends (Libro Unico del Lavoro, D.L. 112/2008 art. 39; GDPR art. 17(3)(b)).',
  HEALTH: 'Kept: health surveillance and accident records are kept 10 years after the employment ends (D.Lgs. 81/2008 art. 25; GDPR art. 17(3)(b)).',
  CUSTOMER: 'Kept: the customer record names the person and the orders and invoices refer to it (c.c. art. 2220: 10 years; GDPR art. 17(3)(b)).',
  MEASUREMENTS: 'Kept: the measurements a garment was made to, for the legal guarantee of conformity (D.Lgs. 206/2005 art. 132: 26 months; GDPR art. 17(3)(e)); their photos go on their own delete date.',
  ALREADY_ERASED: 'Already erased earlier: nothing of the person is left in this record.',
  NOTICE_PROOF: "Kept: the proof that the person was given the privacy notice (GDPR arts. 5(2), 13) names the notice's version, not the person's data.",
  // B-W2b-GF1 (F54): a file attached to what the person sent, which a hold or a retention date keeps.
  LEGAL_HOLD: 'Kept: the file is on legal hold (a dispute, an inspection or a claim needs it as it is; GDPR art. 17(3)(e)).',
  RETAINED: 'Kept until its retention date: the law or a contract keeps the file until then (GDPR art. 17(3)(b)).',
})

/** Why an erasure cannot run now (a 409 each, with its words); a legal hold is not one of these: it keeps a record (KEPT). */
export const ERASURE_BLOCKED = ['PORTAL_USER', 'STILL_ACTIVE', 'ACCOUNT_OPEN', 'NOT_A_PROSPECT', 'TOO_MANY', 'MAIL_SENDING'] as const
export type ErasureBlocked = (typeof ERASURE_BLOCKED)[number]

export const ERASURE_BLOCKED_WORDS: Readonly<Record<ErasureBlocked, string>> = Object.freeze({
  PORTAL_USER: "This person still signs in to the portal with the contact's e-mail: end their portal access first (Portal access › End access), then erase.",
  STILL_ACTIVE: 'This person still works here (an active employee or floor account): their records are needed for the work; erase them after they left.',
  ACCOUNT_OPEN: 'This office account is still open: deactivate it first (Admin › Users), then erase.',
  NOT_A_PROSPECT: 'This inquiry names a contact of a customer, not a prospect: erase the contact instead.',
  TOO_MANY: 'This person has more records than one erasure writes at once: ask the administrator to split it.',
  MAIL_SENDING: 'A mail to this person is being sent right now: try again in two minutes, once it has gone.',
})

export const ERASURE_LIMITS = Object.freeze({ reason: 1000, confirmName: 200, records: 2000 })

/** What a name is replaced with where the database needs one (an employee, a floor account, an office account): a mark, no words. */
export const ERASED_NAME = '—'

/** An erased office account's e-mail: unique, never delivered (RFC 2606 `.invalid`). */
export const erasedEmailOf = (userId: string): string => `erased-${userId}@erased.invalid`

/** The years a legal hold on employment and health records lasts after the employment ends (UNVERIFIED until GATE-PRIVACY). */
export const EMPLOYMENT_KEEP_MONTHS = 60
export const HEALTH_KEEP_MONTHS = 120

const normal = (value: string): string => value.trim().replace(/\s+/g, ' ').toLocaleLowerCase('it')

/** The typed name must be the person's name as shown (spaces and letter case aside): the design's ConfirmPhraseField. */
export function confirmNameProblem(typed: string | null | undefined, shown: string): Issue | null {
  if (normal(typed ?? '') === '' || normal(typed ?? '') !== normal(shown)) return { path: 'confirmName', message: `Type the person's name as shown (${shown}) to confirm.` }
  return null
}

/** The reason a person gives for the erasure: 3-1000 characters, without the person's details (it goes in the audit). */
export function eraseReasonProblem(reason: string | null | undefined): Issue | null {
  const text = (reason ?? '').trim()
  if (text.length < 3) return { path: 'reason', message: 'Say why the person is erased: what they asked and how (a mail, a letter), without their details (3 characters or more).' }
  if (text.length > ERASURE_LIMITS.reason) return { path: 'reason', message: `The reason is at most ${ERASURE_LIMITS.reason} characters.` }
  return null
}
