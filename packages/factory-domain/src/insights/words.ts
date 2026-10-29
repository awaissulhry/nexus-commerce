import type { BusinessDate } from '../core/time'

/**
 * The words of Today's rows (B-W1-52; A2 SCR-029 "Needs me now": one sentence, why it is mine, what waits on it). Each is
 * a PHRASE: a message key and its params, which the web renders in the person's language (factory-web
 * messages/<locale>/home.json `today.w.<key>`), and the same phrase in English (`text`, for callers without a catalogue:
 * logs, the print of another app). A phrase carries no amount: an amount is shown only beside the sentence, for a
 * reader who holds its grain (`presentItem` names the figure; the web formats it).
 *
 * Params: a number named `count` picks the plural (`<key>_one` / `<key>_other`); a param named `…Date` is a business date
 * (YYYY-MM-DD) and `…Month` a month (YYYY-MM), formatted by the reader's language; an array named in CODE_WORDS holds
 * codes, each said in words; any other array is a list of numbers or names, joined (at most five, then "and N more").
 */

export type WordValue = string | number | readonly string[]
export type WordParams = Readonly<Record<string, WordValue>>

export interface Phrase {
  readonly key: string
  readonly params: WordParams
  /** The phrase in English. */
  readonly text: string
}

export interface RowWords {
  readonly sentence: Phrase
  /** What waits on it; null when nothing does. */
  readonly blocks: Phrase | null
}

/** The English words of the codes a phrase may list (the web's catalogue has `today.w.code.<param>.<code>`). */
export const CODE_WORDS: Readonly<Record<string, Readonly<Record<string, string>>>> = Object.freeze({
  checks: { REVISION: 'revision', LABEL_TEMPLATE: 'garment label', CERTIFICATE: 'certificate', WORK_CENTRES: 'work centres', BOM: 'bill of materials', CELLS: 'cells', DEPOSIT: 'deposit', MATERIAL: 'material', BATCH_NUMBER: 'batch number series' },
  reasons: { MARGIN_FLOOR: 'margin under the floor', DISCOUNT_LIMIT: 'discount over the limit', AMOUNT_LIMIT: 'amount over the limit', SPECIAL_ITEM: 'a special item' },
  duties: { RISK_ASSESSMENT: 'the risk to decide', CORRECTIVE_ACTION: 'the corrective action', DISTRIBUTORS: 'the distributors to inform', AUTHORITY: 'the authority to notify' },
  entryKind: { COMPLAINT: 'complaint', NON_CONFORMITY: 'non-conformity', RECALL: 'recall' },
  privacyDuties: { register: 'the record of processing activities', publicNotice: 'the public privacy notice', staffNotice: 'the staff notice', workerNotice: 'the worker notice', dpia: 'the signed DPIA' },
  complianceChecks: { REVISION: 'no released revision', LABEL_TEMPLATE: 'garment label', CERTIFICATE: 'certificate coverage', DECLARATION_OF_CONFORMITY: 'Declaration of Conformity', USER_INFORMATION: 'user information leaflet' },
  steps: { PRODUCTION: 'production', LABELS: 'garment labels', SHIPPING: 'shipping' },
  heldReason: {
    DMARC_FAIL: "its sender's address failed the DMARC check",
    SPAM: 'it looks like spam',
    UNKNOWN_SENDER: 'its sender is not a contact of the record',
    THREAD_CLOSED: 'the thread it answers is closed',
  },
})

/**
 * Every phrase in English, by key (plural forms as `_one` / `_other`). The web's English catalogue holds the same keys
 * (a factory-web test compares them); its Italian one says the same.
 */
export const EN_TEMPLATES: Readonly<Record<string, string>> = Object.freeze({
  listMore: '{shown} and {count} more',

  'ORDER_PROMISE.LATE_one': 'Order {number} for {customer} is {count} day late: it was promised for {promiseDate}.',
  'ORDER_PROMISE.LATE_other': 'Order {number} for {customer} is {count} days late: it was promised for {promiseDate}.',
  'ORDER_PROMISE.AT_RISK_TODAY': 'Order {number} for {customer} is promised for today ({promiseDate}) and is not ready yet.',
  'ORDER_PROMISE.AT_RISK_one': 'Order {number} for {customer} is promised for tomorrow ({promiseDate}) and is not ready yet.',
  'ORDER_PROMISE.AT_RISK_other': 'Order {number} for {customer} is promised for {promiseDate} (in {count} days) and is not ready yet.',
  'ORDER_PROMISE.waitsPieces_one': '{customer} waits for {count} piece.',
  'ORDER_PROMISE.waitsPieces_other': '{customer} waits for {count} pieces.',
  'ORDER_PROMISE.waitsOrder': '{customer} waits for the order.',

  'WORK_ORDER_HELD.HELD_one': 'Work order {number} ({style}) cannot be released: {count} check open ({checks}).',
  'WORK_ORDER_HELD.HELD_other': 'Work order {number} ({style}) cannot be released: {count} checks open ({checks}).',
  'WORK_ORDER_HELD.blocks': 'Production of {orders} waits for it.',

  'LOT_HOLD.QUARANTINE': 'Lot {code} ({item}) waits in quarantine for its release.',
  'LOT_HOLD.QUARANTINE.blocks': 'Its stock cannot be issued to work orders until it is released.',
  'LOT_HOLD.BLOCKED': 'Lot {code} ({item}) is blocked.',
  'LOT_HOLD.BLOCKED_CR_VI': 'Lot {code} ({item}) is blocked: its chromium VI result failed.',
  'LOT_HOLD.BLOCKED.blocks': 'Its stock stays held: reject the lot, or release it again with new evidence.',

  'INVOICE_SDI.REJECTED': 'Invoice {number} for {customer} was rejected by SDI: correct it and send it again by {deadlineDate}.',
  'INVOICE_SDI.REJECTED_NO_DATE': 'Invoice {number} for {customer} was rejected by SDI: correct it and send it again.',
  'INVOICE_SDI.REJECTED.blocks': 'Until it is sent again it counts as never issued.',
  'INVOICE_SDI.ERROR': 'Invoice {number} for {customer} did not reach SDI: send it again.',
  'INVOICE_SDI.ERROR.blocks': 'The customer has no valid invoice yet.',
  'INVOICE_SDI.NOT_DELIVERABLE': 'SDI could not deliver invoice {number} to {customer}, and no courtesy copy went out.',
  'INVOICE_SDI.NOT_DELIVERABLE.blocks': 'The customer finds it only in their tax area until they get a copy.',
  'INVOICE_SDI.FILES_PENDING': 'Invoice {number} for {customer} is issued, but its XML or PDF is not stored yet.',
  'INVOICE_SDI.FILES_PENDING.blocks': 'It cannot go to SDI without its XML.',

  'QUOTE_APPROVAL.PENDING': 'Quote {number} for {customer} waits for an approval: {reasons}.',
  'QUOTE_APPROVAL.blocks': 'It cannot be sent to the customer until it is decided.',

  'PO_PROPOSAL.CHANGES_PROPOSED': '{supplier} proposed changes to purchase order {number}: accept or refuse them.',
  'PO_PROPOSAL.blocks': 'Receiving and a new link wait for your answer.',

  'PO_NOT_CONFIRMED.DAYS_one': 'Purchase order {number} to {supplier} is not confirmed {count} day after it was sent.',
  'PO_NOT_CONFIRMED.DAYS_other': 'Purchase order {number} to {supplier} is not confirmed {count} days after it was sent.',
  'PO_NOT_CONFIRMED.HOURS_one': 'Purchase order {number} to {supplier} is not confirmed {count} hour after it was sent.',
  'PO_NOT_CONFIRMED.HOURS_other': 'Purchase order {number} to {supplier} is not confirmed {count} hours after it was sent.',
  'PO_NOT_CONFIRMED.blocks': 'The goods are needed by {neededDate}.',

  'SCAN_CORRECTION.PENDING': 'A correction of the scan of bundle {bundle} at {operation} ({workOrder}) waits for a decision.',
  'SCAN_CORRECTION.blocks': "{workOrder}'s progress counts the report as it was until the correction is decided.",

  'SCAN_REFUSAL.REFUSED': 'A scan sent from {device} was refused: {message}',
  'SCAN_REFUSAL.blocks': "{workOrder}'s progress misses it until it is scanned again or discarded.",

  'INVOICE_TO_ISSUE.OPEN_one': '{customer}: {count} DDT of {ddtMonth} not invoiced yet ({ddts}).',
  'INVOICE_TO_ISSUE.OPEN_other': '{customer}: {count} DDTs of {ddtMonth} not invoiced yet ({ddts}).',
  'INVOICE_TO_ISSUE.dueLeft_one': 'The goods left: invoice them ({docType}) by {dueDate}, {count} day left.',
  'INVOICE_TO_ISSUE.dueLeft_other': 'The goods left: invoice them ({docType}) by {dueDate}, {count} days left.',
  'INVOICE_TO_ISSUE.dueToday': 'The goods left: invoice them ({docType}) today, {dueDate}.',
  'INVOICE_TO_ISSUE.dueLate_one': 'The goods left: the invoice ({docType}) was due by {dueDate}, {count} day ago.',
  'INVOICE_TO_ISSUE.dueLate_other': 'The goods left: the invoice ({docType}) was due by {dueDate}, {count} days ago.',

  'REGISTER_DUTY.OPEN': 'PPE register {entryKind} {reference} ({style}): {duties}.',
  'REGISTER_DUTY.blocks': 'The entry cannot close until these duties are done (Reg. (EU) 2016/425 art. 8).',

  'PRIVACY_DUTY.OPEN_one': '{company}: {count} privacy duty open ({privacyDuties}).',
  'PRIVACY_DUTY.OPEN_other': '{company}: {count} privacy duties open ({privacyDuties}).',
  'PRIVACY_DUTY.blocksFloor': 'Floor work that records workers stays off until the worker notice and the DPIA are in place.',
  'PRIVACY_DUTY.blocksPeople': 'People are not told what the system keeps about them.',

  'STYLE_COMPLIANCE.BLOCKED': 'Style {style} is held by its compliance: {complianceChecks}.',
  'STYLE_COMPLIANCE.blocks': 'It holds up the {steps} of open orders (sales orders: {orders}, work orders: {workOrders}).',

  'MAIL_TO_SORT.TRIAGE': '"{subject}" from {sender} reached no record: sort it.',
  'MAIL_TO_SORT.TRIAGE_NO_SUBJECT': 'Mail from {sender} reached no record: sort it.',
  'MAIL_TO_SORT.TRIAGE.blocks': 'Its sender waits: nobody sees it on a record until it is sorted.',
  'MAIL_TO_SORT.HELD': '"{subject}" from {sender} is held: {heldReason}.',
  'MAIL_TO_SORT.HELD_NO_SUBJECT': 'Mail from {sender} is held: {heldReason}.',
  'MAIL_TO_SORT.HELD.blocks': 'It reaches no thread until a person releases it or throws it away.',
  'MAIL_TO_SORT.FAILED': '"{subject}" from {sender} could not be read.',
  'MAIL_TO_SORT.FAILED_NO_SUBJECT': 'Mail from {sender} could not be read.',
  'MAIL_TO_SORT.FAILED.blocks': 'Throw it away, or ask the sender to send it again.',

  'why.ORDER_PROMISE.orders_manage': "You manage this customer's orders and their promise dates.",
  'why.WORK_ORDER_HELD.workorders_release': 'You release work orders at this site.',
  'why.LOT_HOLD.quality_lots_release': 'You release lots at this site.',
  'why.LOT_HOLD.quality_lots_reject': 'You reject or block lots at this site.',
  'why.INVOICE_SDI.invoices_issue': "You issue and send this customer's invoices.",
  'why.QUOTE_APPROVAL.quotes_approve': "You approve this customer's quotes, and someone else asked.",
  'why.PO_PROPOSAL.purchasing_send': 'You send purchase orders to this supplier.',
  'why.PO_NOT_CONFIRMED.purchasing_send': 'You send purchase orders to this supplier.',
  'why.SCAN_CORRECTION.production_scan_correct': "You decide the floor's scan corrections at this site, and you neither scanned nor asked.",
  'why.SCAN_REFUSAL.production_scan_correct': "You look after this site's floor scans.",
  'why.INVOICE_TO_ISSUE.invoices_manage': "You invoice this customer's shipped goods.",
  'why.REGISTER_DUTY.compliance_register_manage': "You keep this company's PPE register.",
  'why.REGISTER_DUTY.follow': 'You follow this entry up.',
  'why.PRIVACY_DUTY.privacy_manage': "You keep this company's privacy paperwork.",
  'why.STYLE_COMPLIANCE.compliance_declarations_manage': "You file the styles' Declarations of Conformity and leaflets.",
  'why.STYLE_COMPLIANCE.compliance_certificates_manage': 'You keep the type-examination certificates.',
  'why.STYLE_COMPLIANCE.compliance_labels_manage': 'You keep the garment label templates.',
  'why.STYLE_COMPLIANCE.product_bom_release': 'You release style revisions.',
  'why.MAIL_TO_SORT.email_triage': "You sort this company's received mail.",
})

/** At most five values, then "and N more". */
export function listed(values: readonly string[], max = 5): string {
  const shown = values.slice(0, max).join(', ')
  return values.length > max ? render('listMore', { shown, count: values.length - max }) : shown
}

function word(name: string, value: WordValue): string {
  if (Array.isArray(value)) {
    const codes = CODE_WORDS[name]
    return listed(codes ? value.map((code) => codes[code] ?? code) : value)
  }
  return String(value)
}

/** A key with its params in English (the plural from `count`). Throws on a key nobody declared: a typo is a bug. */
export function render(key: string, params: WordParams): string {
  const count = params.count
  const template = EN_TEMPLATES[key] ?? (typeof count === 'number' ? EN_TEMPLATES[`${key}_${count === 1 ? 'one' : 'other'}`] : undefined)
  if (template === undefined) throw new Error(`insights words: no template for ${key}`)
  return template.replace(/\{(\w+)\}/g, (whole, name: string) => (name in params ? word(name, params[name]!) : whole))
}

export function phrase(key: string, params: WordParams = {}): Phrase {
  return Object.freeze({ key, params: Object.freeze({ ...params }), text: render(key, params) })
}

/** Why a row is the person's: per kind and the permission they act with (`why.<KIND>.<permission with _>`). */
export const whyKey = (kind: string, permission: string): string => `why.${kind}.${permission.replace(/\./g, '_')}`

// ---- one function per kind ---------------------------------------------------------------------------------------------

export function orderPromiseWords(facts: { readonly number: string; readonly customer: string; readonly state: 'LATE' | 'AT_RISK'; readonly days: number; readonly promiseDate: BusinessDate; readonly toShip: number }): RowWords {
  const base = { number: facts.number, customer: facts.customer, promiseDate: facts.promiseDate }
  const sentence =
    facts.state === 'LATE'
      ? phrase('ORDER_PROMISE.LATE', { ...base, count: facts.days })
      : facts.days === 0
        ? phrase('ORDER_PROMISE.AT_RISK_TODAY', base)
        : phrase('ORDER_PROMISE.AT_RISK', { ...base, count: facts.days })
  return { sentence, blocks: facts.toShip > 0 ? phrase('ORDER_PROMISE.waitsPieces', { customer: facts.customer, count: facts.toShip }) : phrase('ORDER_PROMISE.waitsOrder', { customer: facts.customer }) }
}

/** `checks`: the release check's BLOCKED codes (production/work-orders/release). */
export function workOrderHeldWords(facts: { readonly number: string; readonly style: string; readonly checks: readonly string[]; readonly orders: readonly string[] }): RowWords {
  return {
    sentence: phrase('WORK_ORDER_HELD.HELD', { number: facts.number, style: facts.style, count: facts.checks.length, checks: facts.checks }),
    blocks: facts.orders.length > 0 ? phrase('WORK_ORDER_HELD.blocks', { orders: facts.orders }) : null,
  }
}

export function lotHoldWords(facts: { readonly code: string; readonly item: string; readonly state: 'QUARANTINE' | 'BLOCKED'; readonly crViFail: boolean }): RowWords {
  const base = { code: facts.code, item: facts.item }
  return facts.state === 'QUARANTINE'
    ? { sentence: phrase('LOT_HOLD.QUARANTINE', base), blocks: phrase('LOT_HOLD.QUARANTINE.blocks') }
    : { sentence: phrase(facts.crViFail ? 'LOT_HOLD.BLOCKED_CR_VI' : 'LOT_HOLD.BLOCKED', base), blocks: phrase('LOT_HOLD.BLOCKED.blocks') }
}

export type SdiAttentionState = 'REJECTED' | 'ERROR' | 'NOT_DELIVERABLE' | 'FILES_PENDING'

export function invoiceSdiWords(facts: { readonly number: string; readonly customer: string; readonly state: SdiAttentionState; readonly deadline: BusinessDate | null }): RowWords {
  const base = { number: facts.number, customer: facts.customer }
  const sentence =
    facts.state === 'REJECTED'
      ? facts.deadline
        ? phrase('INVOICE_SDI.REJECTED', { ...base, deadlineDate: facts.deadline })
        : phrase('INVOICE_SDI.REJECTED_NO_DATE', base)
      : phrase(`INVOICE_SDI.${facts.state}`, base)
  return { sentence, blocks: phrase(`INVOICE_SDI.${facts.state}.blocks`) }
}

export function quoteApprovalWords(facts: { readonly number: string; readonly customer: string; readonly reasons: readonly string[] }): RowWords {
  return { sentence: phrase('QUOTE_APPROVAL.PENDING', { number: facts.number, customer: facts.customer, reasons: facts.reasons }), blocks: phrase('QUOTE_APPROVAL.blocks') }
}

export function poProposalWords(facts: { readonly number: string; readonly supplier: string }): RowWords {
  return { sentence: phrase('PO_PROPOSAL.CHANGES_PROPOSED', { number: facts.number, supplier: facts.supplier }), blocks: phrase('PO_PROPOSAL.blocks') }
}

export function poNotConfirmedWords(facts: { readonly number: string; readonly supplier: string; readonly hours: number; readonly requestedDate: BusinessDate | null }): RowWords {
  const base = { number: facts.number, supplier: facts.supplier }
  return {
    sentence: facts.hours >= 48 ? phrase('PO_NOT_CONFIRMED.DAYS', { ...base, count: Math.floor(facts.hours / 24) }) : phrase('PO_NOT_CONFIRMED.HOURS', { ...base, count: facts.hours }),
    blocks: facts.requestedDate ? phrase('PO_NOT_CONFIRMED.blocks', { neededDate: facts.requestedDate }) : null,
  }
}

export function scanCorrectionWords(facts: { readonly workOrder: string; readonly operation: string; readonly bundle: string }): RowWords {
  return { sentence: phrase('SCAN_CORRECTION.PENDING', { workOrder: facts.workOrder, operation: facts.operation, bundle: facts.bundle }), blocks: phrase('SCAN_CORRECTION.blocks', { workOrder: facts.workOrder }) }
}

/** `message`: the refusal as the floor recorded it (the scans module's words). */
export function scanRefusalWords(facts: { readonly device: string; readonly message: string; readonly workOrder: string | null }): RowWords {
  return { sentence: phrase('SCAN_REFUSAL.REFUSED', { device: facts.device, message: facts.message }), blocks: facts.workOrder ? phrase('SCAN_REFUSAL.blocks', { workOrder: facts.workOrder }) : null }
}

/** `daysLeft` negative: the deadline passed. `month`: YYYY-MM of the DDTs. */
export function invoiceToIssueWords(facts: { readonly customer: string; readonly month: string; readonly ddts: readonly string[]; readonly docType: string; readonly dueBy: BusinessDate; readonly daysLeft: number }): RowWords {
  const due = { docType: facts.docType, dueDate: facts.dueBy }
  return {
    sentence: phrase('INVOICE_TO_ISSUE.OPEN', { customer: facts.customer, count: facts.ddts.length, ddtMonth: facts.month, ddts: facts.ddts }),
    blocks:
      facts.daysLeft > 0
        ? phrase('INVOICE_TO_ISSUE.dueLeft', { ...due, count: facts.daysLeft })
        : facts.daysLeft === 0
          ? phrase('INVOICE_TO_ISSUE.dueToday', due)
          : phrase('INVOICE_TO_ISSUE.dueLate', { ...due, count: -facts.daysLeft }),
  }
}

export function registerDutyWords(facts: { readonly reference: string; readonly kind: string; readonly style: string; readonly duties: readonly string[] }): RowWords {
  return { sentence: phrase('REGISTER_DUTY.OPEN', { entryKind: [facts.kind], reference: facts.reference, style: facts.style, duties: facts.duties }), blocks: phrase('REGISTER_DUTY.blocks') }
}

/** The duties whose absence keeps floor work that records workers off (the privacy gate, B-W1-36). */
export const FLOOR_PRIVACY_DUTIES: readonly string[] = Object.freeze(['workerNotice', 'dpia'])

export function privacyDutyWords(facts: { readonly company: string; readonly duties: readonly string[] }): RowWords {
  const floor = facts.duties.some((duty) => FLOOR_PRIVACY_DUTIES.includes(duty))
  return {
    sentence: phrase('PRIVACY_DUTY.OPEN', { company: facts.company, count: facts.duties.length, privacyDuties: facts.duties }),
    blocks: phrase(floor ? 'PRIVACY_DUTY.blocksFloor' : 'PRIVACY_DUTY.blocksPeople'),
  }
}

export function styleComplianceWords(facts: { readonly style: string; readonly checks: readonly string[]; readonly steps: readonly string[]; readonly orders: number; readonly workOrders: number }): RowWords {
  return {
    sentence: phrase('STYLE_COMPLIANCE.BLOCKED', { style: facts.style, complianceChecks: facts.checks }),
    blocks: phrase('STYLE_COMPLIANCE.blocks', { steps: facts.steps, orders: facts.orders, workOrders: facts.workOrders }),
  }
}

export type MailAttentionState = 'TRIAGE' | 'HELD' | 'FAILED'

/** `sender`: the name, else the address; `subject` null: no subject. */
export function mailToSortWords(facts: { readonly sender: string; readonly subject: string | null; readonly state: MailAttentionState; readonly heldReason: string | null }): RowWords {
  const params = { sender: facts.sender, ...(facts.subject ? { subject: facts.subject } : {}), ...(facts.state === 'HELD' ? { heldReason: [facts.heldReason ?? 'UNKNOWN_SENDER'] } : {}) }
  return { sentence: phrase(`MAIL_TO_SORT.${facts.state}${facts.subject ? '' : '_NO_SUBJECT'}`, params), blocks: phrase(`MAIL_TO_SORT.${facts.state}.blocks`) }
}

// ---- waiting on others (English: the screen is W2) ---------------------------------------------------------------------

export const approvalReasonWords = (reasons: readonly string[]): string => word('reasons', reasons)

export function approvalRequestWords(facts: { readonly number: string; readonly customer: string; readonly reasons: readonly string[] }): string {
  return `Your approval request for quote ${facts.number} (${facts.customer}: ${approvalReasonWords(facts.reasons)}) is not decided yet.`
}

export function poConfirmationWords(facts: { readonly number: string; readonly supplier: string }): string {
  return `Purchase order ${facts.number} you sent to ${facts.supplier} is not confirmed yet.`
}

export function quoteAnswerWords(facts: { readonly number: string; readonly revision: number; readonly customer: string }): string {
  return `Quote ${facts.number} (revision ${facts.revision}) you sent to ${facts.customer} is not answered yet.`
}
