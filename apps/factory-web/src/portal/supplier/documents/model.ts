import type { ActionDue } from '@nexus/ui/patterns/ActionList/index'
import { checkUploadDetails, DOCUMENT_LIMITS, SUPPLIER_DOCUMENT_CATEGORIES } from '@nexus/factory-domain/purchasing/portal-profile/documents'
import type { AnnounceBody, AskedRow, DocumentRow, DocumentState, RecordRef, SupplierDocuments } from './api'

/**
 * The supplier's Documents page, the pure part (B-W2b-193, SCR-190; design portal.supplier.documents): what "We ask for"
 * lists and why (the API's codes in our words: never its English `reason`), "Your documents" with their state, what the
 * upload pop-up sends and what holds it, and why a button waits. No API, no screen. Words are `portal-supplier-profile`
 * keys (`documents.*`, `upload.*`, `held.*`); a supplier never sees a price (C2): nothing here has one.
 */

export const NS = 'portal-supplier-profile'
export const DOCUMENTS_PATH = '/documents'

export interface Words {
  key: string
  params?: Readonly<Record<string, string | number>>
}

export type Tone = 'neutral' | 'info' | 'success' | 'warning' | 'danger'

/** The kinds a supplier sends (factory-domain purchasing/portal-profile/documents.ts). */
export const CATEGORIES: readonly string[] = SUPPLIER_DOCUMENT_CATEGORIES

/** What the store takes for a supplier's document (the API's CERTIFICATE kind: PDF, JPEG or PNG, at most 20 MB). */
export const UPLOAD_TYPES: readonly string[] = ['application/pdf', 'image/jpeg', 'image/png']
export const UPLOAD_ACCEPT = '.pdf,.jpg,.jpeg,.png'
export const UPLOAD_MAX_BYTES = 20 * 1024 * 1024

/** A document's kind as a words key (`documents.kind.<CATEGORY>`; none: "A document"). */
export const kindKey = (category: string | null): string => (category && CATEGORIES.includes(category) ? `documents.kind.${category}` : 'documents.kind.OTHER')

/** What a document is for, in words: the company, or one of its orders, ship notices or jobs. */
export function forWords(record: Pick<RecordRef, 'type' | 'label'>): Words {
  if (record.type === 'PurchaseOrder' || record.type === 'ShipNotice' || record.type === 'SubcontractOrder') return { key: `documents.for.${record.type}`, params: { label: record.label } }
  return { key: 'documents.for.Party' }
}

// ── "We ask for" ─────────────────────────────────────────────────────────────────────────────────────────────────────────
/** Where an upload goes and what it answers (the API's announce body without the details). */
export interface UploadTarget {
  taskId?: string | null
  recordType?: string | null
  recordId?: string | null
  replacesFileId?: string | null
  /** The kind asked for (preset in the pop-up), or null: the supplier chooses. */
  category: string | null
  /** What it is for, in words (the pop-up's sub-title). */
  for: Words
  /** It replaces this accepted document (a new version; the old one stays until we accept the new one). */
  replaces?: string | null
}

export const ASK_GROUPS = ['NEEDED', 'RENEW', 'AGAIN', 'ASKED'] as const
export type AskGroup = (typeof ASK_GROUPS)[number]
const GROUP_OF: Readonly<Record<AskedRow['source'], AskGroup>> = { RULE: 'NEEDED', EXPIRY: 'RENEW', REFUSED: 'AGAIN', ASKED: 'ASKED' }

export interface AskItem {
  id: string
  group: AskGroup
  /** "Test report for purchase order PO-2026-0007". */
  title: { kind: string; for: Words }
  /** Why we ask, in our words. */
  why: Words
  /** The records it is needed for (links on the page), the company left out. */
  records: readonly RecordRef[]
  /** The due day (`YYYY-MM-DD`) and its state today. */
  due: { day: string; state: ActionDue['state'] } | null
  /** Why Upload waits (a key), or null. */
  held: string | null
  /** A document of this kind for it is with us already. */
  waiting: boolean
  target: UploadTarget
}

const DAY = 86_400_000
const dayNumber = (day: string): number => Date.parse(`${day.slice(0, 10)}T00:00:00Z`) / DAY

/** Where a due day stands today: overdue, today, within a week (soon), later. */
export function dueStateOf(day: string, today: string): ActionDue['state'] {
  const left = dayNumber(day) - dayNumber(today)
  if (left < 0) return 'overdue'
  if (left === 0) return 'today'
  return left <= 7 ? 'soon' : 'later'
}

/** The facts that hold every send of the page. */
export interface SendFacts {
  preview: boolean
  offline: boolean
  mayUpload: boolean
}

/** Why the page cannot send a document now (a `held.*` key), or null. */
export function uploadHeld(facts: SendFacts): string | null {
  if (facts.preview) return 'held.preview'
  if (facts.offline) return 'held.offline'
  if (!facts.mayUpload) return 'held.mayNotUpload'
  return null
}

const notCompany = (records: readonly RecordRef[]): RecordRef[] => records.filter((record) => record.type !== 'Party')

/** Why we ask for it, in our words (from the codes; the API's English sentence is never shown). */
export function whyOf(row: AskedRow, documents: readonly DocumentRow[]): Words {
  if (row.source === 'RULE') {
    const records = notCompany(row.forRecords).map((record) => record.label)
    const expired = row.state === 'EXPIRED'
    if (records.length === 0) return { key: expired ? 'documents.why.companyExpired' : row.level === 'BLOCK' ? 'documents.why.company' : 'documents.why.companyWarn' }
    const params = { records: records.join(', '), count: records.length }
    if (expired) return { key: 'documents.why.ruleExpired', params }
    return { key: row.level === 'BLOCK' ? 'documents.why.ruleBlock' : 'documents.why.ruleWarn', params }
  }
  if (row.source === 'EXPIRY') return { key: 'documents.why.expiry' }
  if (row.source === 'ASKED') return row.askedBy ? { key: 'documents.why.askedBy', params: { name: row.askedBy } } : { key: 'documents.why.asked' }
  const refused = documents.find((doc) => doc.state === 'REJECTED' && doc.record.id === row.record.id && (row.category === null || doc.category === row.category) && doc.reason)
  return refused?.reason ? { key: 'documents.why.refusedReason', params: { reason: refused.reason } } : { key: 'documents.why.refused' }
}

/** The target of a "We ask for" row's Upload: the request it answers, else the record the rule names. */
export function askTarget(row: AskedRow): UploadTarget {
  const base = { category: row.category, for: forWords(row.record) }
  return row.taskId ? { ...base, taskId: row.taskId } : { ...base, recordType: row.record.type, recordId: row.record.id }
}

/** The rows of "We ask for", in the API's order (due first), each with why, when and whether Upload may act. */
export function askItems(read: Pick<SupplierDocuments, 'requested' | 'documents' | 'today'>, facts: SendFacts): AskItem[] {
  const held = uploadHeld(facts)
  return read.requested.map((row) => ({
    id: row.key,
    group: GROUP_OF[row.source],
    title: { kind: kindKey(row.category), for: forWords(row.record) },
    why: whyOf(row, read.documents),
    records: notCompany(row.forRecords.length > 0 ? row.forRecords : [row.record]),
    due: row.dueOn ? { day: row.dueOn, state: dueStateOf(row.dueOn, read.today) } : null,
    held: held ?? (row.waiting ? 'held.waiting' : null),
    waiting: row.waiting,
    target: askTarget(row),
  }))
}

/** The rows by group, groups in the page's order, empty groups left out. */
export function askGroups(items: readonly AskItem[]): { group: AskGroup; items: AskItem[] }[] {
  return ASK_GROUPS.map((group) => ({ group, items: items.filter((item) => item.group === group) })).filter((entry) => entry.items.length > 0)
}

// ── "Your documents" ─────────────────────────────────────────────────────────────────────────────────────────────────────
export const STATE_TONE: Readonly<Record<DocumentState, Tone>> = { ACCEPTED: 'success', WAITING: 'info', CHECKING: 'info', HELD: 'warning', EXPIRED: 'danger', REJECTED: 'danger', NOT_RECEIVED: 'neutral' }

/** We shared it back (accepted, or accepted and since expired): it can be opened and downloaded. */
export const isShared = (state: DocumentState): boolean => state === 'ACCEPTED' || state === 'EXPIRED'

export interface DocRow {
  id: string
  state: DocumentState
  tone: Tone
  kind: string
  name: string
  contentType: string
  sizeBytes: number
  record: RecordRef
  for: Words
  issuer: string | null
  number: string | null
  issuedOn: string | null
  expiresOn: string | null
  daysLeft: number | null
  /** Expires within 30 days (and not yet): the countdown is shown. */
  expiringSoon: boolean
  articles: readonly string[]
  lots: readonly string[]
  /** Our refusal's reason (the reviewer's words to the supplier). */
  reason: string | null
  sentAt: string | null
  decidedAt: string | null
  shared: boolean
  /** Replace with a new version (accepted and current). */
  replace: UploadTarget | null
  /** Upload again (refused): the request we opened for it, else its record. */
  again: UploadTarget | null
}

export const EXPIRING_DAYS = 30

/** The supplier's documents as the list shows them (the API's order: refused, held, expired, checking, waiting, accepted). */
export function docRows(read: Pick<SupplierDocuments, 'documents' | 'requested'>): DocRow[] {
  return read.documents.map((doc) => {
    const forThis = forWords(doc.record)
    const request = doc.state === 'REJECTED' ? read.requested.find((row) => row.source === 'REFUSED' && row.taskId && row.record.id === doc.record.id && (row.category === null || row.category === doc.category)) : undefined
    return {
      id: doc.fileId,
      state: doc.state,
      tone: STATE_TONE[doc.state],
      kind: kindKey(doc.category),
      name: doc.name,
      contentType: doc.contentType,
      sizeBytes: doc.sizeBytes,
      record: doc.record,
      for: forThis,
      issuer: doc.issuer,
      number: doc.number,
      issuedOn: doc.issuedOn,
      expiresOn: doc.expiresOn,
      daysLeft: doc.daysLeft,
      expiringSoon: doc.state === 'ACCEPTED' && doc.daysLeft !== null && doc.daysLeft >= 0 && doc.daysLeft <= EXPIRING_DAYS,
      articles: doc.articles,
      lots: doc.lots,
      reason: doc.state === 'REJECTED' ? doc.reason : null,
      sentAt: doc.sentAt,
      decidedAt: doc.decidedAt,
      shared: isShared(doc.state),
      replace: doc.canReplace && isShared(doc.state) ? { replacesFileId: doc.fileId, category: doc.category, for: forThis, replaces: doc.name } : null,
      again: doc.state === 'REJECTED' ? (request?.taskId ? { taskId: request.taskId, category: doc.category, for: forThis } : { recordType: doc.record.type, recordId: doc.record.id, category: doc.category, for: forThis }) : null,
    }
  })
}

/** Why a document cannot be chosen for "Download N" (a key), or null: only what we shared back opens. */
export function downloadHeld(row: Pick<DocRow, 'state'>): string | null {
  if (isShared(row.state)) return null
  return row.state === 'REJECTED' ? 'held.notAccepted' : 'held.notShared'
}

// ── the upload pop-up ────────────────────────────────────────────────────────────────────────────────────────────────────
export interface UploadDraft {
  category: string
  issuer: string
  number: string
  issuedOn: string
  expiresOn: string
  /** Article codes, separated by commas or new lines. */
  articles: string
  /** Lot or dye-batch codes, separated by commas or new lines. */
  lots: string
  note: string
}

export type UploadField = keyof UploadDraft | 'file'

/** The chosen file as the pop-up shows it (the File itself stays with the page). */
export interface PickedFile {
  name: string
  size: number
  type: string
}

export const emptyDraft = (category: string | null): UploadDraft => ({ category: category ?? '', issuer: '', number: '', issuedOn: '', expiresOn: '', articles: '', lots: '', note: '' })

/** Something typed or chosen (leaving asks first). */
export const draftTyped = (draft: UploadDraft, file: PickedFile | null, preset: string | null): boolean =>
  file !== null || draft.category !== (preset ?? '') || (['issuer', 'number', 'issuedOn', 'expiresOn', 'articles', 'lots', 'note'] as const).some((field) => draft[field].trim() !== '')

/** The codes typed in one field, one each, as typed. */
export const codesOf = (text: string): string[] =>
  text
    .split(/[\n,;]+/)
    .map((code) => code.trim())
    .filter((code) => code !== '')

const FIELD_OF: Readonly<Record<string, UploadField>> = { category: 'category', issuer: 'issuer', number: 'number', issuedOn: 'issuedOn', expiresOn: 'expiresOn', articles: 'articles', lots: 'lots', note: 'note' }
const PROBLEM_OF: Readonly<Record<UploadField, string>> = {
  category: 'upload.problem.kind',
  issuer: 'upload.problem.tooLong',
  number: 'upload.problem.tooLong',
  issuedOn: 'upload.problem.issued',
  expiresOn: 'upload.problem.expires',
  articles: 'upload.problem.codes',
  lots: 'upload.problem.codes',
  note: 'upload.problem.tooLong',
  file: 'upload.problem.file',
}

/** What holds the upload, field by field (keys): the API's own rules (factory-domain checkUploadDetails), and the file. */
export function uploadProblems(draft: UploadDraft, file: PickedFile | null, today: string): Partial<Record<UploadField, string>> {
  const problems: Partial<Record<UploadField, string>> = {}
  const check = checkUploadDetails({ category: draft.category, issuer: draft.issuer, number: draft.number, issuedOn: draft.issuedOn, expiresOn: draft.expiresOn, articles: codesOf(draft.articles), lots: codesOf(draft.lots), note: draft.note }, today)
  if (!check.ok) {
    for (const issue of check.issues) {
      const field = FIELD_OF[issue.path.replace(/^body\//, '').split('/')[0] ?? '']
      if (field && !problems[field]) problems[field] = PROBLEM_OF[field]
    }
  }
  if (!file) problems.file = 'upload.problem.file'
  else if (!UPLOAD_TYPES.includes(file.type)) problems.file = 'upload.problem.fileType'
  else if (file.size > UPLOAD_MAX_BYTES) problems.file = 'upload.problem.fileSize'
  else if (file.size === 0) problems.file = 'upload.problem.fileEmpty'
  return problems
}

export const LIMITS = { issuer: DOCUMENT_LIMITS.issuer, number: DOCUMENT_LIMITS.number, note: DOCUMENT_LIMITS.note, codes: DOCUMENT_LIMITS.scopeItems } as const

const orNull = (value: string): string | null => (value.trim() === '' ? null : value.trim())

/** What "Send for review" announces (the bytes follow to the store, then the confirm). */
export function uploadBody(draft: UploadDraft, target: UploadTarget, file: PickedFile, sha256: string): AnnounceBody {
  return {
    category: draft.category,
    issuer: orNull(draft.issuer),
    number: orNull(draft.number),
    issuedOn: orNull(draft.issuedOn),
    expiresOn: orNull(draft.expiresOn),
    articles: codesOf(draft.articles),
    lots: codesOf(draft.lots),
    note: orNull(draft.note),
    originalName: file.name,
    contentType: file.type,
    sizeBytes: file.size,
    sha256,
    ...(target.replacesFileId ? { replacesFileId: target.replacesFileId } : target.taskId ? { taskId: target.taskId } : target.recordType ? { recordType: target.recordType, recordId: target.recordId ?? null } : {}),
  }
}

/** A refusal of the upload in our words (a key), from the API's kind and issue paths. */
export function sendRefusal(kind: string | null, paths: readonly string[] = []): string {
  if (kind === 'forbidden') return 'upload.failed.forbidden'
  if (kind === 'conflict') return 'upload.failed.answered'
  if (kind === 'not_found') return 'upload.failed.gone'
  if (kind === 'invalid') return paths.some((path) => path.includes('replacesFileId') || path.includes('taskId')) ? 'upload.failed.gone' : 'upload.failed.invalid'
  if (kind === 'rate_limited') return 'upload.failed.wait'
  if (kind === 'signed_out') return 'upload.failed.signedOut'
  if (kind === 'store') return 'upload.failed.store'
  return 'upload.failed.network'
}

/** "1,2 MB" / "820 KB": a file's size in the page's language. */
export function sizeWords(bytes: number, locale: string): string {
  const format = (value: number, digits: number) => new Intl.NumberFormat(locale === 'it' ? 'it-IT' : 'en-GB', { maximumFractionDigits: digits }).format(value)
  if (bytes >= 1024 * 1024) return `${format(bytes / (1024 * 1024), 1)} MB`
  return `${format(Math.max(1, Math.round(bytes / 1024)), 0)} KB`
}
