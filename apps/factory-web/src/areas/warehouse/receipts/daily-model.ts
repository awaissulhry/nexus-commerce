import { DISCREPANCY_KINDS, DISCREPANCY_LIMITS, type DiscrepancyKind, type DiscrepancyStatus, type SettleStatus } from '@nexus/factory-domain/inventory/receipts/discrepancies'
import { DOCUMENT_REQUEST_LIMITS, documentRequestMail, wantedDocuments as wantedOf, type WantedDocument } from '@nexus/factory-domain/inventory/receipts/document-request'
import { isBusinessDate } from '@nexus/factory-domain/core/time'
import { Dec } from '@nexus/factory-domain/tax/decimal'
import { isApiError, issuePath } from '../../../lib/api/errors'
import type { PickerReason } from '../../_shared/reasons/api'
import type { Part } from '../../_shared/buying/model'
import type { LotWithHides, Receipt, Uom } from './api'
import type { ClaimFromBody, Discrepancy, DiscrepancyBody, HideListSummary, Recipient, ReportBody, ReportCheck, ReportSent, RequestBody, RequestCheck, ThreadEmail } from './daily-api'

/**
 * The receipt every day (B-W2a-63 on B-W2a-31; design warehouse.receipts rec "Discrepancies", "Documents check", pop
 * rc-disc-new and rc-disc-send, tab rc-tab-disc; SCM-115, SCM-118, SCM-248), pure: who may do what, the New discrepancy
 * draft and why its Save is held, the moves a person makes by hand (agreed, credited, closed), which discrepancies a
 * report or a claim may name, the report's recipients and the send, "Request from supplier" (B-W2a-F4: the documents the
 * lots wait for, the supplier's own contacts, the standard text in the supplier's language with a short note), the
 * tannery hide list's totals in words, and every refusal by the path the API names — never the API's English. Words
 * are keys of the `warehouse-receipts` catalogue.
 */

export const NAMESPACE = 'warehouse-receipts'

/** Words with their values: a message key of `warehouse-receipts` and its parameters. */
export interface Say {
  key: string
  params?: Readonly<Record<string, string | number>>
}
export const say = (key: string, params?: Say['params']): Say => (params ? { key, params } : { key })

// ---- who may do what ------------------------------------------------------------------------------------------------------

export interface ReceiptDailyCan {
  /** inventory.discrepancies.manage: record, change, settle, photograph. */
  manage: boolean
  /** inventory.discrepancies.report: the report to the supplier. */
  report: boolean
  /** files.upload: a photo. */
  upload: boolean
  /** inventory.receive: the supplier's DDT photo. */
  receive: boolean
  /** purchasing.view: the supplier claims that pursue a discrepancy. */
  claimsView: boolean
  /** purchasing.claims.manage: a claim from discrepancies. */
  claims: boolean
  /** inventory.receipts.documents.request: "Request from supplier" (B-W2a-F4; the narrow request, not email.send). */
  request: boolean
  /** imports.run + files.upload: the tannery hide list. */
  importRun: boolean
  importApply: boolean
  importView: boolean
}

export function dailyCan(permissions: readonly string[]): ReceiptDailyCan {
  const held = new Set(permissions)
  return {
    manage: held.has('inventory.discrepancies.manage'),
    report: held.has('inventory.discrepancies.report'),
    upload: held.has('files.upload'),
    receive: held.has('inventory.receive'),
    claimsView: held.has('purchasing.view'),
    claims: held.has('purchasing.claims.manage'),
    request: held.has('inventory.receipts.documents.request'),
    importRun: held.has('imports.run') && held.has('files.upload') && held.has('inventory.receive'),
    importApply: held.has('imports.apply'),
    importView: held.has('imports.view'),
  }
}

// ---- a discrepancy ----------------------------------------------------------------------------------------------------------

export const DISCREPANCY_TONE: Readonly<Record<DiscrepancyStatus, 'warning' | 'info' | 'success' | 'neutral'>> = Object.freeze({ OPEN: 'warning', SENT: 'info', AGREED: 'info', CREDITED: 'success', CLOSED: 'neutral' })

/** A receipt takes a discrepancy while it is open or posted (a reversed or cancelled one takes none). */
export const takesDiscrepancies = (receipt: Pick<Receipt, 'status'>): boolean => receipt.status === 'OPEN' || receipt.status === 'POSTED'

const isKind = (value: string): value is DiscrepancyKind => (DISCREPANCY_KINDS as readonly string[]).includes(value)

/** A photo waiting to be uploaded with the discrepancy (the capture's result). */
export interface PendingPhoto {
  key: string
  blob: Blob
  name: string
}

export interface DiscrepancyDraft {
  /** An OPEN discrepancy being changed; null: a new one. */
  id: string | null
  version: number | null
  /** A code of the DISCREPANCY list ('' none chosen). */
  reasonCode: string
  /** The kind, needed when the reason is the tenant's own code (not itself a kind) or none is chosen. */
  kind: DiscrepancyKind | ''
  /** The receipt line it is about ('' the delivery as a whole). */
  lineId: string
  quantity: string
  uom: Uom | ''
  note: string
  photos: PendingPhoto[]
  /** The camera step is open. */
  photoStep: boolean
}

export const blankDiscrepancy = (lineId = ''): DiscrepancyDraft => ({ id: null, version: null, reasonCode: '', kind: '', lineId, quantity: '', uom: '', note: '', photos: [], photoStep: false })

/** An OPEN discrepancy as a draft to change (its photos stay; new ones are added). */
export function draftOf(discrepancy: Discrepancy): DiscrepancyDraft {
  return {
    id: discrepancy.id,
    version: discrepancy.version,
    reasonCode: discrepancy.reasonCode ?? '',
    kind: discrepancy.kind,
    lineId: discrepancy.receiptLine?.id ?? '',
    quantity: discrepancy.quantity ? discrepancy.quantity.replace(/\.?0+$/, '') : '',
    uom: discrepancy.uom ?? '',
    note: discrepancy.note ?? '',
    photos: [],
    photoStep: false,
  }
}

/** The kind the draft names: the reason's own when it is a kind, else the one chosen; null: none yet. */
export function draftKind(draft: Pick<DiscrepancyDraft, 'reasonCode' | 'kind'>): DiscrepancyKind | null {
  if (draft.reasonCode && isKind(draft.reasonCode)) return draft.reasonCode
  return draft.kind || null
}

/** The reason's own kind decides it: the kind picker shows only for a tenant's own code, or with no reason. */
export const kindAsked = (draft: Pick<DiscrepancyDraft, 'reasonCode'>): boolean => !draft.reasonCode || !isKind(draft.reasonCode)

/** A decimal typed by a person: a comma or a point; null when it is no number above 0 with at most four decimals. */
export function typedQuantity(text: string): string | null {
  const cleaned = text.trim().replace(',', '.')
  if (!/^\d+(\.\d{1,4})?$/.test(cleaned)) return null
  return new Dec(cleaned).greaterThan(0) ? cleaned : null
}

/** Why Save is held, in words (null: it may be saved). The first problem only, in the form's order. */
export function discrepancyHeld(draft: DiscrepancyDraft, receipt: Pick<Receipt, 'status'>, can: ReceiptDailyCan, reasons: readonly PickerReason[], busy: boolean): Say | null {
  if (!can.manage) return say('held.noManage')
  if (!takesDiscrepancies(receipt)) return say('held.receiptClosed')
  if (busy) return say('held.busy')
  if (draftKind(draft) === null) return say(draft.reasonCode ? 'held.ownReasonKind' : 'held.kind')
  const hasQuantity = draft.quantity.trim() !== ''
  if (hasQuantity && typedQuantity(draft.quantity) === null) return say('held.quantity')
  if (hasQuantity !== (draft.uom !== '')) return say('held.quantityUnit')
  const reason = reasons.find((entry) => entry.list === 'DISCREPANCY' && entry.code === draft.reasonCode)
  if (reason?.needsDetail && !draft.note.trim()) return say('held.noteNeeded')
  if (draft.note.trim().length > DISCREPANCY_LIMITS.note) return say('held.noteLong', { max: DISCREPANCY_LIMITS.note })
  if (draft.photos.length > 0 && !can.upload) return say('held.noUpload')
  return null
}

/** The body the API takes (a change sends every field: what was cleared is sent as null). */
export function discrepancyBody(draft: DiscrepancyDraft): DiscrepancyBody {
  const kind = draftKind(draft)
  const quantity = typedQuantity(draft.quantity)
  return {
    ...(kind ? { kind } : {}),
    reasonCode: draft.reasonCode || null,
    receiptLineId: draft.lineId || null,
    quantity: quantity && draft.uom ? quantity : null,
    uom: quantity && draft.uom ? draft.uom : null,
    note: draft.note.trim() || null,
  }
}

/** The unit a line's discrepancy is counted in by default: the material's base unit. */
export function lineUnit(receipt: Pick<Receipt, 'lines'>, lineId: string): Uom | '' {
  return receipt.lines.find((line) => line.id === lineId)?.item.baseUom ?? ''
}

/** Why a discrepancy cannot be changed now (null: it can). */
export function changeHeld(discrepancy: Discrepancy, can: ReceiptDailyCan): Say | null {
  if (!can.manage) return say('held.noManage')
  if (discrepancy.status !== 'OPEN') return say(discrepancy.status === 'CLOSED' ? 'held.closedNoChange' : 'held.sentNoChange')
  return null
}

/** Why it cannot be removed (recorded by mistake): only while open and without a photo. */
export function removeHeld(discrepancy: Discrepancy, can: ReceiptDailyCan): Say | null {
  if (!can.manage) return say('held.noManage')
  if (discrepancy.status !== 'OPEN') return say('held.sentNoRemove')
  if (discrepancy.photos.length > 0) return say('held.photosNoRemove')
  return null
}

/** Why a photo cannot be added (null: it can). */
export function photoHeld(discrepancy: Discrepancy, can: ReceiptDailyCan): Say | null {
  if (!can.manage) return say('held.noManage')
  if (!can.upload) return say('held.noUpload')
  if (discrepancy.status === 'CLOSED') return say('held.closedNoPhoto')
  if (discrepancy.photos.length >= DISCREPANCY_LIMITS.photos) return say('held.photosFull', { max: DISCREPANCY_LIMITS.photos })
  return null
}

/** The moves a person makes by hand from here (the report moves OPEN → SENT). */
export function settleMoves(status: DiscrepancyStatus): SettleStatus[] {
  switch (status) {
    case 'OPEN':
      return ['CLOSED']
    case 'SENT':
      return ['AGREED', 'CLOSED']
    case 'AGREED':
      return ['CREDITED', 'CLOSED']
    case 'CREDITED':
      return ['CLOSED']
    default:
      return []
  }
}

/** Why the settle is held (closing needs what settled it, or why it is not pursued). */
export function settleHeld(to: SettleStatus, note: string, can: ReceiptDailyCan, busy: boolean): Say | null {
  if (!can.manage) return say('held.noManage')
  if (busy) return say('held.busy')
  if (to === 'CLOSED' && !note.trim()) return say('held.closeNote')
  if (note.trim().length > DISCREPANCY_LIMITS.resolution) return say('held.noteLong', { max: DISCREPANCY_LIMITS.resolution })
  return null
}

/** A row that may go into a report (OPEN, or SENT again as a reminder) or a claim; else why not. */
export function reportableWhy(discrepancy: Pick<Discrepancy, 'status'>): Say | null {
  if (discrepancy.status === 'OPEN' || discrepancy.status === 'SENT') return null
  return say(discrepancy.status === 'CLOSED' ? 'disc.notReportable.CLOSED' : 'disc.notReportable.answered')
}

/** The report names these: the selection (OPEN and SENT), else every OPEN one. */
export function reportIds(rows: readonly Discrepancy[], selected: readonly string[]): string[] {
  const picked = rows.filter((row) => selected.includes(row.id) && reportableWhy(row) === null)
  return (picked.length > 0 ? picked : rows.filter((row) => row.status === 'OPEN')).map((row) => row.id)
}

/** Why "Send report" is held on the tab (before the dialog opens). */
export function reportHeld(rows: readonly Discrepancy[], selected: readonly string[], can: ReceiptDailyCan): Say | null {
  if (!can.report) return say('held.noReport')
  const chosen = rows.filter((row) => selected.includes(row.id))
  if (chosen.length > 0 && chosen.every((row) => reportableWhy(row) !== null)) return say('held.selectionAnswered')
  if (chosen.length === 0 && !rows.some((row) => row.status === 'OPEN')) return say('held.nothingOpen')
  return null
}

/** Why "Claim from the supplier" is held for the selection: open or reported ones, each on a line, none pursued yet. */
export function claimHeld(rows: readonly Discrepancy[], selected: readonly string[], can: ReceiptDailyCan): Say | null {
  if (!can.claims) return say('held.noClaims')
  const chosen = rows.filter((row) => selected.includes(row.id))
  if (chosen.length === 0) return say('held.pickForClaim')
  const answered = chosen.find((row) => reportableWhy(row) !== null)
  if (answered) return say('held.claimAnswered', { seq: answered.seq })
  const wholeDelivery = chosen.find((row) => row.receiptLine === null)
  if (wholeDelivery) return say('held.claimNoLine', { seq: wholeDelivery.seq })
  const pursued = chosen.find((row) => row.claims.some((claim) => claim.status !== 'CLOSED' && claim.status !== 'CANCELLED'))
  if (pursued) return say('held.claimPursued', { seq: pursued.seq, number: pursued.claims.find((claim) => claim.status !== 'CLOSED' && claim.status !== 'CANCELLED')!.number })
  return null
}

// ---- the report to the supplier (pop rc-disc-send) --------------------------------------------------------------------------

export interface ReportDraft {
  ids: string[]
  check: Part<ReportCheck>
  /** The contacts picked (the check's `suggested` ones to start with). */
  contactIds: string[]
  cc: string
  language: 'it' | 'en'
  subject: string
  /** The office's own words; '' = the standard text in the supplier's language. */
  message: string
  preview: { src: Uint8Array | null; problem: string | null }
  sent: ReportSent | null
  /** After the send: the mail's delivery state as last read (QUEUED until the worker sends it). */
  delivery: string | null
}

export function reportDraft(ids: string[]): ReportDraft {
  return { ids, check: { value: null, problem: null }, contactIds: [], cc: '', language: 'it', subject: '', message: '', preview: { src: null, problem: null }, sent: null, delivery: null }
}

/** The draft once the check answered: the suggested recipients, its language and subject. */
export function withCheck(draft: ReportDraft, check: ReportCheck): ReportDraft {
  return { ...draft, check: { value: check, problem: null }, contactIds: check.recipients.filter((recipient) => recipient.suggested).map((recipient) => recipient.contactId), language: check.language, subject: draft.subject || check.subject }
}

export function parseCc(text: string): { valid: string[]; invalid: string[] } {
  const parts = [...new Set(text.split(/[;,\s]+/).map((part) => part.trim()).filter(Boolean))]
  const ok = (value: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value) && value.length <= 254
  return { valid: parts.filter(ok), invalid: parts.filter((part) => !ok(part)) }
}

/** The check's problems by what they name (never its English): the company's letterhead, contacts, the selection. */
export function checkProblemKeys(check: ReportCheck): string[] {
  const keys = check.problems.map((problem) => {
    const path = problem.path.toLowerCase()
    if (path.includes('contact') || path.includes('recipient')) return 'report.problem.noContact'
    if (path.includes('discrepanc')) return 'report.problem.selection'
    if (path.includes('company') || path.includes('legal') || path.includes('letterhead')) return 'report.problem.company'
    if (path.includes('identity') || path.includes('email')) return 'report.problem.identity'
    return 'report.problem.other'
  })
  return [...new Set(keys)]
}

export function reportSendHeld(draft: ReportDraft, can: ReceiptDailyCan, busy: boolean): Say | null {
  if (!can.report) return say('held.noReport')
  if (draft.sent) return say('held.sentAlready')
  if (busy) return say('held.busy')
  const check = draft.check.value
  if (!check) return say(draft.check.problem ? 'held.checkFailed' : 'held.loading')
  const problem = checkProblemKeys(check).find((key) => key !== 'report.problem.noContact')
  if (problem) return say(problem)
  if (check.recipients.length === 0) return say('report.problem.noContact')
  if (draft.contactIds.length === 0) return say('held.pickRecipient')
  if (draft.contactIds.length > DISCREPANCY_LIMITS.reportRecipients) return say('held.tooManyRecipients', { max: DISCREPANCY_LIMITS.reportRecipients })
  const cc = parseCc(draft.cc)
  if (cc.invalid.length > 0) return say('held.cc', { list: cc.invalid.join(', ') })
  if (draft.message.trim().length > DISCREPANCY_LIMITS.message) return say('held.noteLong', { max: DISCREPANCY_LIMITS.message })
  return null
}

export function reportBody(draft: ReportDraft): ReportBody {
  const cc = parseCc(draft.cc).valid
  return {
    discrepancyIds: draft.ids,
    contactIds: draft.contactIds,
    ...(cc.length > 0 ? { cc } : {}),
    subject: draft.subject.trim() || null,
    message: draft.message.trim() || null,
    language: draft.language,
  }
}

/** The recipient's state after the send: the mail's delivery (one mail to every recipient). */
export type DeliveryWord = 'queued' | 'sent' | 'delivered' | 'bounced' | 'failed'
export function deliveryOf(email: Pick<ThreadEmail, 'status'> | null): DeliveryWord {
  switch (email?.status) {
    case 'SENT':
      return 'sent'
    case 'DELIVERED':
      return 'delivered'
    case 'BOUNCED':
    case 'COMPLAINED':
      return 'bounced'
    case 'FAILED':
      return 'failed'
    default:
      return 'queued'
  }
}

export const recipientsOf = (check: ReportCheck | null, ids: readonly string[]): Recipient[] => (check?.recipients ?? []).filter((recipient) => ids.includes(recipient.contactId))

// ---- a claim from discrepancies -----------------------------------------------------------------------------------------------

export interface ClaimDraft {
  ids: string[]
  reasonCode: string
  note: string
  remedy: 'CREDIT' | 'REPLACEMENT'
}

export const claimDraft = (ids: string[]): ClaimDraft => ({ ids, reasonCode: '', note: '', remedy: 'CREDIT' })

export function claimDraftHeld(draft: ClaimDraft, reasons: readonly PickerReason[], can: ReceiptDailyCan, busy: boolean): Say | null {
  if (!can.claims) return say('held.noClaims')
  if (busy) return say('held.busy')
  if (!draft.reasonCode) return say('held.claimReason')
  const reason = reasons.find((entry) => entry.list === 'CLAIM' && entry.code === draft.reasonCode)
  if (reason?.needsDetail && !draft.note.trim()) return say('held.noteNeeded')
  return null
}

export const claimBody = (draft: ClaimDraft): ClaimFromBody => ({ reasonCode: draft.reasonCode, reasonNote: draft.note.trim() || null, remedy: draft.remedy, discrepancyIds: draft.ids })

// ---- "Request from supplier" (Documents check; B-W2a-F4) ---------------------------------------------------------------------

export type Wanted = WantedDocument

/**
 * The documents this delivery still waits for (factory-domain inventory/receipts/document-request: the same rule the
 * API applies): a lot in quarantine for its Cr VI result, a PPE component's certificate, a missing DDT.
 */
export const wantedDocuments = (receipt: Pick<Receipt, 'supplierDdtNumber' | 'ddtPhotos'>, lots: readonly LotWithHides[]): Wanted[] => wantedOf({ supplierDdtNumber: receipt.supplierDdtNumber, ddtPhotoCount: receipt.ddtPhotos.length }, lots)

export interface RequestDraft {
  /** What the delivery waits for (the Documents tab's list, then the check's); `asked` names the ones the mail asks for. */
  wanted: Wanted[]
  /** The API's check: the supplier's contacts (the only recipients), the documents, the supplier's language. */
  check: Part<RequestCheck>
  /** Contact ids. */
  to: string[]
  asked: string[]
  language: 'it' | 'en'
  /** A short note of one's own under the standard text. */
  note: string
  sentTo: string[] | null
}

export const requestDraft = (wanted: Wanted[]): RequestDraft => ({ wanted, check: { value: null, problem: null }, to: [], asked: wanted.map((entry) => entry.key), language: 'it', note: '', sentTo: null })

/** The check arrived: its documents, the suggested contact (and every other quality contact), the supplier's language. */
export function withRequestCheck(draft: RequestDraft, check: RequestCheck): RequestDraft {
  const quality = check.recipients.filter((recipient) => recipient.roles.includes('QUALITY')).map((recipient) => recipient.contactId)
  const suggested = check.recipients.filter((recipient) => recipient.suggested).map((recipient) => recipient.contactId)
  const before = new Set(draft.asked)
  const kept = check.wanted.filter((entry) => before.has(entry.key)).map((entry) => entry.key)
  return { ...draft, check: { value: check, problem: null }, wanted: check.wanted, asked: kept.length > 0 ? kept : check.wanted.map((entry) => entry.key), to: quality.length > 0 ? quality : suggested, language: check.language }
}

/** The documents asked, in the receipt's order. */
const askedOf = (draft: RequestDraft): Wanted[] => draft.wanted.filter((entry) => draft.asked.includes(entry.key))

/** The subject and text the supplier gets (the API composes the same from the same rule): a preview, not editable. */
export function requestPreview(draft: RequestDraft, receipt: Pick<Receipt, 'number' | 'supplierDdtNumber' | 'supplierDdtDate'>): { subject: string; body: string } {
  const day = receipt.supplierDdtDate && isBusinessDate(receipt.supplierDdtDate) ? receipt.supplierDdtDate : null
  return documentRequestMail({ language: draft.language, receiptNumber: receipt.number, supplierDdtNumber: receipt.supplierDdtNumber, supplierDdtDate: day, asked: askedOf(draft), note: draft.note })
}

export const requestBody = (draft: RequestDraft): RequestBody => ({ contactIds: [...draft.to], documents: askedOf(draft).map((entry) => entry.key), language: draft.language, note: draft.note.trim() || null })

/** A receipt waits for documents while it is open or posted. */
const takesRequest = (receipt: Pick<Receipt, 'status'>): boolean => receipt.status === 'OPEN' || receipt.status === 'POSTED'

/** Why "Request from supplier" is held on the Documents tab (null: it may open). */
export function requestOpenHeld(receipt: Pick<Receipt, 'status'>, wanted: readonly Wanted[] | null, can: ReceiptDailyCan): Say | null {
  if (!can.request) return say('held.noRequest')
  if (!takesRequest(receipt)) return say('held.requestClosed')
  if (wanted === null) return say('held.loading')
  if (wanted.length === 0) return say('held.nothingWanted')
  return null
}

export function requestHeld(draft: RequestDraft, can: ReceiptDailyCan, busy: boolean): Say | null {
  if (!can.request) return say('held.noRequest')
  if (draft.sentTo) return say('held.sentAlready')
  if (busy) return say('held.busy')
  if (!draft.check.value) return say(draft.check.problem ? 'held.contactsFailed' : 'held.loading')
  if (draft.check.value.recipients.length === 0) return say('report.problem.noContact')
  if (draft.to.length === 0) return say('held.pickRecipient')
  if (askedOf(draft).length === 0) return say('held.pickDocument')
  if (draft.note.trim().length > DOCUMENT_REQUEST_LIMITS.note) return say('refused.requestNote', { max: DOCUMENT_REQUEST_LIMITS.note })
  return null
}

// ---- the DDT photo ---------------------------------------------------------------------------------------------------------------

/** Why the DDT photo is held on the Documents tab. */
export function ddtPhotoHeld(receipt: Pick<Receipt, 'status'>, can: ReceiptDailyCan): Say | null {
  if (!can.receive) return say('held.noReceive')
  if (!can.upload) return say('held.noUpload')
  if (receipt.status === 'CANCELLED') return say('held.receiptCancelled')
  return null
}

// ---- the tannery hide list (SCM-248) --------------------------------------------------------------------------------------------

/** Why "Import hide list" is held on the list's band. */
export function hideListHeld(can: ReceiptDailyCan): Say | null {
  if (!can.receive) return say('held.noReceive')
  if (!can.importRun) return say('held.noImport')
  return null
}

/** A hide list's line against its order line, in words: within the tolerance, short, over (needs the rows' reason). */
export function hideListLineWords(line: HideListSummary['lines'][number]): Say {
  if (line.kind === 'OVER') return say(line.needsReason ? 'hideList.judge.overReason' : 'hideList.judge.over')
  if (line.kind === 'SHORT') return say('hideList.judge.short')
  return say('hideList.judge.within')
}

// ---- refusals in words -------------------------------------------------------------------------------------------------------------

const pathsOf = (error: unknown): string[] => (isApiError(error) ? error.issues.map(issuePath).map((path) => path.replace(/\./g, '/')) : [])
const has = (paths: readonly string[], part: string) => paths.some((path) => path.includes(part))

/** A refused write by its kind (the path words come first). */
export function kindSay(error: unknown): Say {
  if (!isApiError(error)) return say('problem.write')
  switch (error.kind) {
    case 'conflict':
      return say('problem.changed')
    case 'forbidden':
    case 'step_up':
      return say('problem.forbidden')
    case 'not_found':
      return say('problem.gone')
    case 'invalid':
      return say('problem.invalid')
    case 'rate_limited':
      return say('problem.slowDown')
    case 'unavailable':
      return say('problem.offline')
    default:
      return say('problem.write')
  }
}

/** A failed read, as a key of the catalogue. */
export function readSay(error: unknown): string {
  if (!isApiError(error)) return 'problem.read'
  if (error.kind === 'forbidden' || error.kind === 'step_up') return 'problem.forbidden'
  if (error.kind === 'unavailable') return 'problem.offline'
  if (error.kind === 'not_found') return 'problem.gone'
  return 'problem.read'
}

/** A discrepancy's save refused: the field it names (reason, kind, line, quantity, note), else a state that moved. */
export function discrepancyProblem(error: unknown): Say {
  const paths = pathsOf(error)
  if (has(paths, 'reasonCode')) return say('refused.reason')
  if (has(paths, 'kind')) return say('refused.kind')
  if (has(paths, 'receiptLineId')) return say('refused.line')
  if (has(paths, 'quantity') || has(paths, 'uom')) return say('refused.quantity')
  if (has(paths, 'note')) return say('refused.note')
  if (isApiError(error) && error.kind === 'conflict') return say('refused.moved')
  return kindSay(error)
}

export function settleProblem(error: unknown): Say {
  const paths = pathsOf(error)
  if (has(paths, 'note')) return say('held.closeNote')
  if (has(paths, 'to')) return say('refused.settleMove')
  return kindSay(error)
}

export function reportProblem(error: unknown): Say {
  const paths = pathsOf(error)
  if (has(paths, 'contactIds')) return say('report.problem.noContact')
  if (has(paths, 'cc')) return say('refused.cc')
  if (has(paths, 'discrepancyIds')) return say('report.problem.selection')
  if (isApiError(error) && error.kind === 'conflict') return say('refused.reportMoved')
  return kindSay(error)
}

export function claimProblem(error: unknown): Say {
  const paths = pathsOf(error)
  if (has(paths, 'reasonCode') || has(paths, 'reasonNote')) return say('refused.claimReason')
  if (has(paths, 'from/discrepancyIds')) return say('refused.claimDiscrepancies')
  if (has(paths, 'lines') || has(paths, 'quantity')) return say('refused.claimLines')
  return kindSay(error)
}

export function photoProblem(error: unknown): Say {
  if (error instanceof TypeError && !isApiError(error)) return say('refused.photoStore')
  if (isApiError(error) && (has(pathsOf(error), 'contentType') || has(pathsOf(error), 'sizeBytes'))) return say('refused.photoType')
  return kindSay(error)
}

export function requestProblem(error: unknown): Say {
  const paths = pathsOf(error)
  if (isApiError(error) && error.code === 'invalid_state') return say('refused.requestClosed')
  if (has(paths, 'contactIds/')) return say('refused.requestContact')
  if (has(paths, 'contactIds')) return say('report.problem.noContact')
  if (has(paths, 'documents/')) return say('refused.requestDocuments')
  if (has(paths, 'documents')) return say('refused.requestNothing')
  if (has(paths, 'note')) return say('refused.requestNote', { max: DOCUMENT_REQUEST_LIMITS.note })
  if (has(paths, 'identity')) return say('report.problem.identity')
  return kindSay(error)
}

// ---- B-W2b-14: the supplier's DDT number and date corrected on a posted receipt (Z1:02) --------------------------------------

export const DDT_FIX_LIMITS = Object.freeze({ number: 60, reason: 500 })

export interface DdtFixDraft {
  ddtNumber: string
  /** YYYY-MM-DD, or empty. */
  ddtDate: string
  reason: string
}

/** The draft starts from what the receipt names now. */
export const ddtFixDraftOf = (receipt: Pick<Receipt, 'supplierDdtNumber' | 'supplierDdtDate'>): DdtFixDraft => ({ ddtNumber: receipt.supplierDdtNumber ?? '', ddtDate: receipt.supplierDdtDate ?? '', reason: '' })

/** Why "Correct" is held on the Documents tab (null: it may open). */
export function ddtFixOpenHeld(receipt: Pick<Receipt, 'status'>, can: ReceiptDailyCan): Say | null {
  if (!can.receive) return say('held.noReceive')
  if (receipt.status === 'OPEN') return say('ddtFix.held.open')
  if (receipt.status !== 'POSTED') return say(`ddtFix.held.${receipt.status}`)
  return null
}

/** Why its Save is held: a real change, a date not after today and with its number, a few words of why. */
export function ddtFixHeld(draft: DdtFixDraft, receipt: Pick<Receipt, 'status' | 'supplierDdtNumber' | 'supplierDdtDate'>, can: ReceiptDailyCan, busy: boolean, today: string): Say | null {
  const open = ddtFixOpenHeld(receipt, can)
  if (open) return open
  if (busy) return say('held.busy')
  const number = draft.ddtNumber.trim()
  const date = draft.ddtDate.trim()
  if (number === (receipt.supplierDdtNumber ?? '') && date === (receipt.supplierDdtDate ?? '')) return say('ddtFix.held.same')
  if (number.length > DDT_FIX_LIMITS.number) return say('ddtFix.held.number', { max: DDT_FIX_LIMITS.number })
  if (date !== '' && !isBusinessDate(date)) return say('ddtFix.held.date')
  if (date !== '' && date > today) return say('ddtFix.held.future')
  if (date !== '' && number === '') return say('ddtFix.held.dateAlone')
  if (draft.reason.trim().length < 3) return say('ddtFix.held.reason')
  return null
}

export const ddtFixBody = (draft: DdtFixDraft, receipt: Pick<Receipt, 'version'>) => ({
  version: receipt.version,
  supplierDdtNumber: draft.ddtNumber.trim() === '' ? null : draft.ddtNumber.trim(),
  supplierDdtDate: draft.ddtDate.trim() === '' ? null : draft.ddtDate.trim(),
  reason: draft.reason.trim(),
})

/** A correction refused, in our words (by the path the API names). */
export function ddtFixProblem(error: unknown): Say {
  const paths = pathsOf(error)
  if (isApiError(error) && error.code === 'invalid_state') return say('ddtFix.refused.state')
  if (isApiError(error) && error.kind === 'conflict') return say('refused.moved')
  if (has(paths, 'supplierDdtDate')) return say('ddtFix.held.future')
  if (has(paths, 'supplierDdtNumber')) return say('ddtFix.held.same')
  if (has(paths, 'reason')) return say('ddtFix.held.reason')
  return kindSay(error)
}
