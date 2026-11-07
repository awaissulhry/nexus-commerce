import type { Issue } from '../../core/errors'
import type { BusinessDate } from '../../core/time'
import { addDays, daysUntil, expiryDateProblem, EXPIRY_FIRST_DAY } from '../../files/expiry/rules'
import { CATEGORY_WORDS } from '../../files/required/rules'

/**
 * A supplier's documents in the portal (B-W2b-189; SCM-096; design portal.supplier.documents "We ask for", "Your documents",
 * the Upload pop-up; QHS-112 "Supplier certificate upload and review"), pure.
 *
 *   what      a certificate (LWG audit, ISO 9001, an insurance, a DURC), a test report (Cr VI for a dye batch) or a
 *             declaration (REACH, a signed code of conduct): FileCategory SUPPLIER_CERTIFICATE, TEST_REPORT, DECLARATION
 *   where     on the supplier's own record (a party's document counts for all its records, B-W2b-177) or on one of its
 *             records we asked about (a purchase order, a ship notice, a subcontract order)
 *   flow      sent → scanned → WAITING for our check, unshared (the office sees it, the supplier sees it only as "waiting");
 *             a buyer or quality person ACCEPTS it (what it is, until when: it is then shared back as seen and counts for
 *             the required-document rules) or REFUSES it with the reason (the supplier is asked to upload it again)
 *   states    NOT_RECEIVED (announced, never arrived), CHECKING (the virus scan), HELD (the file could not be taken: it did
 *             not match what was announced, or the scan refused it), WAITING, ACCEPTED, EXPIRED (accepted, its date
 *             passed), REJECTED
 *
 * The details the supplier types (issuer, number, issued on, expires on, the articles and lots it covers) are kept with the
 * upload; the reviewer confirms the kind and the expiry date when accepting. No money anywhere.
 */

export const SUPPLIER_DOCUMENT_CATEGORIES = ['SUPPLIER_CERTIFICATE', 'TEST_REPORT', 'DECLARATION'] as const
export type SupplierDocumentCategory = (typeof SUPPLIER_DOCUMENT_CATEGORIES)[number]
export const isSupplierDocumentCategory = (value: unknown): value is SupplierDocumentCategory =>
  typeof value === 'string' && (SUPPLIER_DOCUMENT_CATEGORIES as readonly string[]).includes(value)

/** The records a supplier's document may be for: its own record, or one of its records we asked about. */
export const SUPPLIER_DOCUMENT_RECORD_TYPES = ['Party', 'PurchaseOrder', 'ShipNotice', 'SubcontractOrder'] as const
export type SupplierDocumentRecordType = (typeof SUPPLIER_DOCUMENT_RECORD_TYPES)[number]
export const isSupplierDocumentRecordType = (value: unknown): value is SupplierDocumentRecordType =>
  typeof value === 'string' && (SUPPLIER_DOCUMENT_RECORD_TYPES as readonly string[]).includes(value)

export const SUPPLIER_DOCUMENT_STATES = ['NOT_RECEIVED', 'CHECKING', 'HELD', 'WAITING', 'ACCEPTED', 'EXPIRED', 'REJECTED'] as const
export type SupplierDocumentState = (typeof SUPPLIER_DOCUMENT_STATES)[number]

/** Limits of what the supplier types. */
export const DOCUMENT_LIMITS = Object.freeze({ issuer: 200, number: 100, scopeItems: 20, scopeItem: 60, note: 1000, reason: 500, reasonMin: 3 })
/** A refused upload asks the supplier again by this many days (its request's due). */
export const REUPLOAD_DAYS = 14
/** How long a refused upload stays on the supplier's list. */
export const REFUSED_SHOWN_DAYS = 90

export interface UploadDetailsInput {
  readonly category: string
  readonly issuer?: string | null | undefined
  readonly number?: string | null | undefined
  readonly issuedOn?: string | null | undefined
  readonly expiresOn?: string | null | undefined
  /** The articles it covers: the supplier's codes or ours, as typed. */
  readonly articles?: readonly string[] | undefined
  /** The lots or dye batches it covers. */
  readonly lots?: readonly string[] | undefined
  readonly note?: string | null | undefined
}

export interface UploadDetails {
  readonly category: SupplierDocumentCategory
  readonly issuer: string | null
  readonly number: string | null
  readonly issuedOn: BusinessDate | null
  readonly expiresOn: BusinessDate | null
  readonly articles: readonly string[]
  readonly lots: readonly string[]
  readonly note: string | null
}

const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/
const DATE = /^\d{4}-\d{2}-\d{2}$/

/** Trimmed text, null when blank; inner runs of spaces kept as typed. */
export const cleanLine = (value: string | null | undefined): string | null => {
  const text = value?.trim() ?? ''
  return text === '' ? null : text
}

function textProblem(value: string | null, path: string, max: number, issues: Issue[]): void {
  if (value === null) return
  if (value.length > max) issues.push({ path, message: `At most ${max} characters.` })
  else if (CONTROL.test(value)) issues.push({ path, message: 'Plain text only.' })
}

function listOf(values: readonly string[] | undefined, path: string, issues: Issue[]): string[] {
  const cleaned: string[] = []
  for (const [index, raw] of (values ?? []).entries()) {
    const text = cleanLine(raw)
    if (text === null) continue
    if (text.length > DOCUMENT_LIMITS.scopeItem || /[\n\r]/.test(text) || CONTROL.test(text)) {
      issues.push({ path: `${path}/${index}`, message: `One code of at most ${DOCUMENT_LIMITS.scopeItem} characters.` })
      continue
    }
    if (!cleaned.includes(text)) cleaned.push(text)
  }
  if (cleaned.length > DOCUMENT_LIMITS.scopeItems) issues.push({ path, message: `At most ${DOCUMENT_LIMITS.scopeItems}.` })
  return cleaned
}

const isDay = (value: string): boolean => DATE.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00Z`)) && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value

/**
 * What the supplier said about the document it sends, checked; issue paths under `body/`. The document must be valid today
 * (an expired one is refused: "send the valid one"); issued on a day not after today.
 */
export function checkUploadDetails(input: UploadDetailsInput, today: BusinessDate): { readonly ok: true; readonly details: UploadDetails } | { readonly ok: false; readonly issues: readonly Issue[] } {
  const issues: Issue[] = []
  if (!isSupplierDocumentCategory(input.category)) issues.push({ path: 'body/category', message: 'A certificate, a test report or a declaration.' })
  const issuer = cleanLine(input.issuer)
  textProblem(issuer, 'body/issuer', DOCUMENT_LIMITS.issuer, issues)
  const number = cleanLine(input.number)
  textProblem(number, 'body/number', DOCUMENT_LIMITS.number, issues)
  const note = cleanLine(input.note)
  if (note !== null && note.length > DOCUMENT_LIMITS.note) issues.push({ path: 'body/note', message: `At most ${DOCUMENT_LIMITS.note} characters.` })
  const issuedOn = cleanLine(input.issuedOn)
  if (issuedOn !== null) {
    if (!isDay(issuedOn)) issues.push({ path: 'body/issuedOn', message: 'The issue date is not a date (YYYY-MM-DD).' })
    else if (issuedOn > today) issues.push({ path: 'body/issuedOn', message: 'A document is issued on a day not after today.' })
    else if (issuedOn < EXPIRY_FIRST_DAY) issues.push({ path: 'body/issuedOn', message: 'The issue date is too far in the past.' })
  }
  const expiresOn = cleanLine(input.expiresOn)
  if (expiresOn !== null) {
    const problem = expiryDateProblem(expiresOn, today)
    if (problem) issues.push({ path: 'body/expiresOn', message: problem })
    else if (expiresOn < today) issues.push({ path: 'body/expiresOn', message: `This document expired on ${expiresOn}: send the one valid now.` })
    else if (issuedOn !== null && isDay(issuedOn) && expiresOn < issuedOn) issues.push({ path: 'body/expiresOn', message: 'It expires after the day it was issued.' })
  }
  const articles = listOf(input.articles, 'body/articles', issues)
  const lots = listOf(input.lots, 'body/lots', issues)
  if (issues.length > 0) return { ok: false, issues }
  return { ok: true, details: { category: input.category as SupplierDocumentCategory, issuer, number, issuedOn, expiresOn, articles, lots, note } }
}

/** What the supplier sees of one of its documents. */
export function documentStateOf(file: {
  readonly status: string
  readonly quarantineReason: string | null
  readonly decision: 'ACCEPTED' | 'REJECTED' | null
  readonly expiresOn: BusinessDate | null
  readonly today: BusinessDate
}): SupplierDocumentState {
  if (file.decision === 'REJECTED') return 'REJECTED'
  if (file.decision === 'ACCEPTED') return file.expiresOn !== null && file.expiresOn < file.today ? 'EXPIRED' : 'ACCEPTED'
  if (file.status === 'PENDING_UPLOAD') return 'NOT_RECEIVED'
  if (file.status === 'QUARANTINED') return file.quarantineReason === 'scan_pending' ? 'CHECKING' : 'HELD'
  if (file.status === 'AVAILABLE') return 'WAITING'
  return 'HELD'
}

/** Days left on an accepted document's date (negative: expired), or null without a date. */
export const daysLeftOf = (expiresOn: BusinessDate | null, today: BusinessDate): number | null => (expiresOn === null ? null : daysUntil(expiresOn, today))

export interface AcceptInput {
  readonly category: string
  readonly expiresOn: string | null
}

/** The reviewer's acceptance, checked: the kind, and a date not passed (an expired document is refused, not accepted). */
export function acceptProblems(input: AcceptInput, today: BusinessDate): Issue[] {
  const issues: Issue[] = []
  if (!isSupplierDocumentCategory(input.category)) issues.push({ path: 'body/category', message: 'A certificate, a test report or a declaration.' })
  if (input.expiresOn !== null) {
    const problem = expiryDateProblem(input.expiresOn, today)
    if (problem) issues.push({ path: 'body/expiresOn', message: problem })
    else if (input.expiresOn < today) issues.push({ path: 'body/expiresOn', message: 'This date has passed: refuse the document, saying it has expired.' })
  }
  return issues
}

/** The reviewer's refusal: the reason the supplier reads. */
export function refuseProblems(reason: string | null | undefined): Issue[] {
  const text = cleanLine(reason)
  if (text === null || text.length < DOCUMENT_LIMITS.reasonMin) return [{ path: 'body/reason', message: 'Say why, in words the supplier understands.' }]
  if (text.length > DOCUMENT_LIMITS.reason) return [{ path: 'body/reason', message: `At most ${DOCUMENT_LIMITS.reason} characters.` }]
  return []
}

/** The due date of the request to upload a refused document again. */
export const reuploadDueOf = (today: BusinessDate): BusinessDate => addDays(today, REUPLOAD_DAYS)

// ---- words (the API's sentences; the portal screens say their own, B-W2b-193) -----------------------------------------------

const KIND_WORDS: Readonly<Record<string, string>> = Object.freeze({ ...CATEGORY_WORDS, SUPPLIER_CERTIFICATE: 'certificate' })
export const kindWords = (category: string | null): string => (category === null ? 'document' : (KIND_WORDS[category] ?? 'document'))

/** The verb of a status move the rule waits for, as the supplier reads it. */
const MOVE_WORDS: Readonly<Record<string, string>> = Object.freeze({
  'PurchaseOrder.SENT': 'send purchase order {label}',
  'PurchaseOrder.CONFIRMED': 'confirm purchase order {label}',
  'PurchaseOrder.RECEIVED': 'receive the goods of purchase order {label}',
  'PurchaseOrder.CLOSED': 'close purchase order {label}',
  'ShipNotice.SENT': 'take ship notice {label}',
  'ShipNotice.RECEIVED': 'receive the goods of ship notice {label}',
  'SubcontractOrder.ISSUED': 'issue job {label}',
  'SubcontractOrder.RECEIVED': 'receive the goods of job {label}',
  'SubcontractOrder.CLOSED': 'close job {label}',
  'Party.ACTIVE': 'work with your company',
})

/** Why we ask for a document a rule needs: "Needed before we confirm purchase order PO-2026-0001." */
export function ruleReasonWords(recordType: string, beforeStatus: string, label: string): string {
  const move = (MOVE_WORDS[`${recordType}.${beforeStatus}`] ?? 'go on with {label}').replace('{label}', label)
  return `Needed before we ${move}.`
}

/** Why a request asks: by expiry, by hand, after a refusal. */
export function requestReasonWords(source: 'EXPIRY' | 'ASKED' | 'REFUSED', facts: { readonly label: string; readonly category?: string | null; readonly expiresOn?: string | null; readonly reason?: string | null }): string {
  if (source === 'EXPIRY') return `Your ${kindWords(facts.category ?? null)} on ${facts.label} expires on ${facts.expiresOn ?? 'its date'}: send the new one.`
  if (source === 'REFUSED') return `We could not accept your ${kindWords(facts.category ?? null)} on ${facts.label}: ${facts.reason ?? 'see our message'}. Send it again.`
  return `We asked for a document on ${facts.label}.`
}
