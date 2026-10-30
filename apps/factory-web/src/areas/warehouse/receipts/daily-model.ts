import { DISCREPANCY_KINDS, DISCREPANCY_LIMITS, type DiscrepancyKind, type DiscrepancyStatus, type SettleStatus } from '@nexus/factory-domain/inventory/receipts/discrepancies'
import { Dec } from '@nexus/factory-domain/tax/decimal'
import { isApiError, issuePath } from '../../../lib/api/errors'
import type { PickerReason } from '../../_shared/reasons/api'
import type { Part } from '../../_shared/buying/model'
import type { LotWithHides, Receipt, Uom } from './api'
import type { ClaimFromBody, Discrepancy, DiscrepancyBody, HideListSummary, Recipient, ReportBody, ReportCheck, ReportSent, SupplierContact, ThreadEmail } from './daily-api'

/**
 * The receipt every day (B-W2a-63 on B-W2a-31; design warehouse.receipts rec "Discrepancies", "Documents check", pop
 * rc-disc-new and rc-disc-send, tab rc-tab-disc; SCM-115, SCM-118, SCM-248), pure: who may do what, the New discrepancy
 * draft and why its Save is held, the moves a person makes by hand (agreed, credited, closed), which discrepancies a
 * report or a claim may name, the report's recipients and the send, "Request from supplier" (the documents the lots wait
 * for, in the supplier's language), the tannery hide list's totals in words, and every refusal by the path the API names
 * — never the API's English. Words are keys of the `warehouse-receipts` catalogue.
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
  /** email.send: "Request from supplier" (a mail on the receipt's thread). */
  email: boolean
  /** parties.view: the supplier's contacts. */
  parties: boolean
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
    email: held.has('email.send'),
    parties: held.has('parties.view'),
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

// ---- "Request from supplier" (Documents check) --------------------------------------------------------------------------------

export const DOCUMENT_ASKS = ['CR_VI_REPORT', 'PPE_CERTIFICATE', 'DELIVERY_NOTE'] as const
export type DocumentAsk = (typeof DOCUMENT_ASKS)[number]

export interface Wanted {
  /** `${lotId}:${ask}` or `receipt:DELIVERY_NOTE`. */
  key: string
  ask: DocumentAsk
  lot: { id: string; code: string; supplierLotRef: string | null; dyeBatch: string | null } | null
}

/**
 * The documents this delivery still waits for, from what the receipt knows: a lot in quarantine for its chromium VI
 * result wants the supplier's test report; a certified PPE component, its certificate; a receipt with no DDT number and
 * no photo, the supplier's delivery note. (The full per-lot documents list is Compliance › Tests & substances'.)
 */
export function wantedDocuments(receipt: Pick<Receipt, 'supplierDdtNumber' | 'ddtPhotos'>, lots: readonly LotWithHides[]): Wanted[] {
  const wanted: Wanted[] = []
  for (const lot of lots) {
    if (lot.qualityStatus !== 'QUARANTINE') continue
    const ref = { id: lot.id, code: lot.code, supplierLotRef: lot.supplierLotRef, dyeBatch: lot.dyeBatch }
    if (lot.holds.includes('CR_VI_TEST') && lot.crViStatus === 'PENDING') wanted.push({ key: `${lot.id}:CR_VI_REPORT`, ask: 'CR_VI_REPORT', lot: ref })
    if (lot.holds.includes('PPE_CERTIFICATE')) wanted.push({ key: `${lot.id}:PPE_CERTIFICATE`, ask: 'PPE_CERTIFICATE', lot: ref })
  }
  if (!receipt.supplierDdtNumber && receipt.ddtPhotos.length === 0) wanted.push({ key: 'receipt:DELIVERY_NOTE', ask: 'DELIVERY_NOTE', lot: null })
  return wanted
}

export interface RequestDraft {
  /** What the delivery waits for (the Documents tab's list); `asked` names the ones the mail asks for. */
  wanted: Wanted[]
  contacts: Part<SupplierContact[]>
  to: string[]
  asked: string[]
  language: 'it' | 'en'
  subject: string
  /** The text as the person leaves it; '' until the contacts are read (then the standard words in the language). */
  body: string
  /** The person changed the text: a language switch no longer rewrites it. */
  edited: boolean
  sentTo: string[] | null
}

export const requestDraft = (wanted: Wanted[]): RequestDraft => ({ wanted, contacts: { value: null, problem: null }, to: [], asked: wanted.map((entry) => entry.key), language: 'it', subject: '', body: '', edited: false, sentTo: null })

/** The language the supplier reads: its first picked contact's, else Italian. */
export function requestLanguage(contacts: readonly SupplierContact[], to: readonly string[]): 'it' | 'en' {
  const first = contacts.find((contact) => to.includes(contact.id))
  return first?.language?.toLowerCase().startsWith('en') ? 'en' : 'it'
}

/**
 * The request's standard words in the SUPPLIER's language (Italian or English), not the page's: a mail the supplier
 * reads. The person may change them before sending. No price, no internal note (Owner answer C2).
 */
const REQUEST_WORDS = {
  it: {
    subject: (receipt: string, ddt: string | null) => `Documenti mancanti — ${ddt ? `vostro DDT ${ddt}, ` : ''}nostro ricevimento ${receipt}`,
    hello: 'Buongiorno,',
    intro: (receipt: string, ddt: string | null, date: string | null) => `per la merce ricevuta${ddt ? ` con il vostro DDT ${ddt}${date ? ` del ${date}` : ''}` : ''} (nostro ricevimento ${receipt}) ci mancano i seguenti documenti:`,
    CR_VI_REPORT: 'il rapporto di prova del cromo esavalente (Cr VI)',
    PPE_CERTIFICATE: 'il certificato del componente DPI',
    DELIVERY_NOTE: 'una copia del documento di trasporto (DDT)',
    lot: (code: string, ref: string | null, dye: string | null) => ` — lotto ${ref ? `vostro ${ref}, ` : ''}${dye ? `bagno ${dye}, ` : ''}nostro ${code}`,
    outro: 'I lotti restano in quarantena finché non li riceviamo. Potete rispondere a questa e-mail allegandoli.',
    thanks: 'Grazie e cordiali saluti',
  },
  en: {
    subject: (receipt: string, ddt: string | null) => `Missing documents — ${ddt ? `your delivery note ${ddt}, ` : ''}our receipt ${receipt}`,
    hello: 'Hello,',
    intro: (receipt: string, ddt: string | null, date: string | null) => `for the goods we received${ddt ? ` with your delivery note ${ddt}${date ? ` of ${date}` : ''}` : ''} (our receipt ${receipt}) we are missing these documents:`,
    CR_VI_REPORT: 'the hexavalent chromium (Cr VI) test report',
    PPE_CERTIFICATE: 'the certificate of the PPE component',
    DELIVERY_NOTE: 'a copy of the delivery note (DDT)',
    lot: (code: string, ref: string | null, dye: string | null) => ` — lot ${ref ? `your ${ref}, ` : ''}${dye ? `dye batch ${dye}, ` : ''}our ${code}`,
    outro: 'The lots stay in quarantine until we have them. You can answer this e-mail with the documents attached.',
    thanks: 'Thank you and kind regards',
  },
} as const

/** The request's subject and text in the supplier's language, from what is asked. */
export function requestText(language: 'it' | 'en', receipt: { number: string; supplierDdtNumber: string | null; ddtDay: string | null }, asked: readonly Wanted[]): { subject: string; body: string } {
  const words = REQUEST_WORDS[language]
  const lines = asked.map((entry) => `- ${words[entry.ask]}${entry.lot ? words.lot(entry.lot.code, entry.lot.supplierLotRef, entry.lot.dyeBatch) : ''}`)
  return {
    subject: words.subject(receipt.number, receipt.supplierDdtNumber),
    body: [words.hello, '', words.intro(receipt.number, receipt.supplierDdtNumber, receipt.ddtDay), ...lines, '', words.outro, '', words.thanks].join('\n'),
  }
}

export function requestHeld(draft: RequestDraft, can: ReceiptDailyCan, busy: boolean): Say | null {
  if (!can.email) return say('held.noEmail')
  if (!can.parties) return say('held.noParties')
  if (draft.sentTo) return say('held.sentAlready')
  if (busy) return say('held.busy')
  if (!draft.contacts.value) return say(draft.contacts.problem ? 'held.contactsFailed' : 'held.loading')
  if (draft.contacts.value.length === 0) return say('report.problem.noContact')
  if (draft.to.length === 0) return say('held.pickRecipient')
  if (draft.asked.length === 0) return say('held.pickDocument')
  if (!draft.subject.trim()) return say('held.subject')
  if (!draft.body.trim()) return say('held.body')
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
  if (has(paths, 'to')) return say('refused.requestTo')
  if (has(paths, 'identity')) return say('report.problem.identity')
  return kindSay(error)
}
