import { GUEST_ZIP, zipSafeName } from '../accounting/guest/files'
import type { ApprovalKind } from '../approvals-out/kinds'
import { APPROVAL_LIMITS } from '../approvals-out/rules'
import type { Issue } from '../core/errors'
import type { BusinessDate } from '../core/time'
import type { Words } from '../portal/tasks/kinds'
import { BULK_ASK_MAX } from './bulk'

/**
 * B-PR-46b — a customer's Approve N and Download files of N on My production (production plan §1 "Bulk", §3 "Bulk 'Approve' cannot
 * be undone; the dialog says so before Send", §5 bulk bar; lead pick L26; review fix R-52; wall test PW-12; the Owner rule
 * 2026-11-16: "One brand must not be able to see anything related to any other brand. But we, as the production unit, should be
 * able to see it all. And manage it all as well."), pure: the kinds, the limits, the row codes and the customer's words ("voi",
 * fix-portal-1, 2026-11-18).
 *
 *   Approve N         one review list of the approvals waiting on the picked orders (each with its photo or PDF), ticked one by
 *                     one, one typed name; each request answered as one answer through the approvals answer path, with its own
 *                     rules (a priced counter-offer: the Buyer or the Admin; a named approver: that person) and its own key.
 *                     Approve only. A kind whose yes needs its own page (a revised order: its lines old → new and its prices;
 *                     a concession: the defect we propose to accept; a signature) is held: "Open it to answer".
 *   Download files    one zip of the files the portal's document library lists for those orders BY ROLE (the files shared
 *                     with the customer on them, and their order confirmations only for a role that sees prices), at most as
 *                     much as the accountant's zip holds (accounting/guest/files GUEST_ZIP).
 * At most 50 per action (as the urgency marks and the asks).
 */

/** Requests per Approve N, and orders per review list or zip. */
export const BULK_APPROVE_MAX = BULK_ASK_MAX
export const BULK_FILES_MAX = BULK_ASK_MAX
/** The review list's longest: past it the list says there are more (they wait in Waiting for you). */
export const BULK_REVIEW_MAX = 100

/**
 * The kinds Approve N answers: a yes to what the photos or the PDF show (a sample, a swatch, an artwork, a design proof), a new
 * date, our counter-offer (only by a role with prices when it is priced: its own rule).
 */
export const BULK_APPROVE_KINDS = ['SAMPLE', 'COLOUR', 'LEATHER', 'FABRIC', 'TRIM', 'ARTWORK', 'PROOF', 'REPROMISE', 'COUNTER_OFFER'] as const satisfies readonly ApprovalKind[]
export type BulkApproveKind = (typeof BULK_APPROVE_KINDS)[number]

/** Approve N answers it (else: "Open it to answer"). */
export const approvesInBulk = (kind: string): kind is BulkApproveKind => (BULK_APPROVE_KINDS as readonly string[]).includes(kind)

/** One row of Approve N that was not answered: why, as a code. */
export const APPROVE_ROW_CODES = ['OWN_ANSWER', 'NOT_YOURS', 'HELD', 'CHANGED', 'NOT_DONE'] as const
export type ApproveRowCode = (typeof APPROVE_ROW_CODES)[number]

/**
 * The code of a row's refusal from the answer path's error code: someone else of the customer answers it (a named approver, the
 * Buyer for a priced counter-offer: 403), it takes no answer now (answered, withdrawn, past due, the record moved on: 409 state),
 * it changed since the list was read (409 version), anything else.
 */
export function approveRowCodeOf(errorCode: string): ApproveRowCode {
  switch (errorCode) {
    case 'forbidden':
      return 'NOT_YOURS'
    case 'invalid_state':
      return 'HELD'
    case 'conflict':
      return 'CHANGED'
    default:
      return 'NOT_DONE'
  }
}

/** The body's own problems, for every row alike (a 400 before any request is answered): the typed name, each request once. */
export function approveManyProblems(body: { readonly typedName?: string | null | undefined; readonly items: readonly { readonly requestId: string }[] }): Issue[] {
  const issues: Issue[] = []
  const name = (body.typedName ?? '').trim()
  if (name.length < APPROVAL_LIMITS.typedNameMin) issues.push({ path: 'body/typedName', message: 'Type your full name to sign the approvals.' })
  else if (name.length > APPROVAL_LIMITS.typedName) issues.push({ path: 'body/typedName', message: `At most ${APPROVAL_LIMITS.typedName} characters.` })
  const seen = new Set<string>()
  body.items.forEach((item, index) => {
    if (seen.has(item.requestId)) issues.push({ path: `body/items/${index}/requestId`, message: 'This request is named twice.' })
    seen.add(item.requestId)
  })
  return issues
}

// ---- the customer's words ("voi") -------------------------------------------------------------------------------------------

/** A row of Approve N answered. */
export const APPROVED_WORDS: Words = Object.freeze({ it: 'Approvato.', en: 'Approved.' })

/** A kind Approve N does not answer (a revised order, a concession, a signature): its own page answers it. */
export const OWN_ANSWER_WORDS: Words = Object.freeze({ it: 'Apritela per rispondere: si risponde nella sua pagina.', en: 'Open it to answer: it is answered on its own page.' })

/** Nothing of Approve N was answered (409; each request's words at its place). */
export const NONE_APPROVED_WORDS: Words = Object.freeze({ it: 'Non è stato approvato nulla: vedete ogni richiesta.', en: 'Nothing was approved: see each request.' })

/** Before Send (plan §3: Approve N has no Undo; the dialog says so). */
export const NO_UNDO_WORDS: Words = Object.freeze({
  it: "Un'approvazione firmata qui non si può annullare. Per cambiarla, scriveteci.",
  en: 'A signed approval cannot be undone here. To change it, write to us.',
})

/** The words of a refusal the answer path gives in the reader's language only: the same text in both. */
export const wordsOfRefusal = (message: string): Words => {
  const text = message.trim()
  return text === '' ? { it: 'Non è stato possibile approvarla.', en: 'This could not be approved.' } : { it: text, en: text }
}

// ---- Download files of N ----------------------------------------------------------------------------------------------------

/** The zip's limits: the accountant's (400 files, 100 MB, 25 MB a file). */
export const PRODUCTION_ZIP = GUEST_ZIP

export const PRODUCTION_ZIP_REFUSALS = ['NOTHING_TO_ZIP', 'TOO_MANY_FILES', 'TOO_LARGE', 'FILE_UNAVAILABLE'] as const
export type ProductionZipRefusal = (typeof PRODUCTION_ZIP_REFUSALS)[number]

export const PRODUCTION_ZIP_WORDS: Readonly<Record<ProductionZipRefusal, Words>> = Object.freeze({
  NOTHING_TO_ZIP: { it: 'Per questi ordini non ci sono ancora file da scaricare.', en: 'There are no files to download for these orders yet.' },
  TOO_MANY_FILES: { it: `Uno zip contiene al massimo ${GUEST_ZIP.maxFiles} file: scegliete meno ordini.`, en: `A zip holds at most ${GUEST_ZIP.maxFiles} files: pick fewer orders.` },
  TOO_LARGE: {
    it: `Uno zip contiene al massimo ${Math.round(GUEST_ZIP.maxBytes / (1024 * 1024))} MB (${Math.round(GUEST_ZIP.fileBytes / (1024 * 1024))} MB per file): scegliete meno ordini.`,
    en: `A zip holds at most ${Math.round(GUEST_ZIP.maxBytes / (1024 * 1024))} MB (${Math.round(GUEST_ZIP.fileBytes / (1024 * 1024))} MB a file): pick fewer orders.`,
  },
  FILE_UNAVAILABLE: { it: 'Nessuno di questi file si può leggere ora: scriveteci.', en: 'None of these files can be read now: write to us.' },
})

/** Is the zip of these files within its limits? Null, or the refusal (the accountant zip's rule, accounting/guest/files zipProblem). */
export function productionZipProblem(files: readonly { readonly sizeBytes: number }[]): ProductionZipRefusal | null {
  if (files.length === 0) return 'NOTHING_TO_ZIP'
  if (files.length > PRODUCTION_ZIP.maxFiles) return 'TOO_MANY_FILES'
  const bytes = files.reduce((sum, file) => sum + file.sizeBytes, 0)
  if (bytes > PRODUCTION_ZIP.maxBytes || files.some((file) => file.sizeBytes > PRODUCTION_ZIP.fileBytes)) return 'TOO_LARGE'
  return null
}

/** Each file's path in the zip: `<order number>/<name>`, a repeated name in a folder numbered (`name (2).pdf`). */
export function productionZipPaths(entries: readonly { readonly folder: string; readonly name: string }[]): string[] {
  const taken = new Set<string>()
  return entries.map((entry) => {
    const folder = zipSafeName(entry.folder)
    const name = zipSafeName(entry.name)
    const dot = name.lastIndexOf('.')
    const stem = dot > 0 ? name.slice(0, dot) : name
    const ext = dot > 0 ? name.slice(dot) : ''
    let path = `${folder}/${name}`
    for (let n = 2; taken.has(path.toLowerCase()); n++) path = `${folder}/${stem} (${n})${ext}`
    taken.add(path.toLowerCase())
    return path
  })
}

/** The zip's own name: one order's number, else how many orders and the day. */
export function productionZipName(orderNumbers: readonly string[], day: BusinessDate): string {
  return zipSafeName(orderNumbers.length === 1 ? `${orderNumbers[0]}_files.zip` : `files_${orderNumbers.length}_orders_${day}.zip`)
}
