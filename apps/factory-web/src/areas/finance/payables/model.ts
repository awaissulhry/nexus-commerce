import { isApiError, issuePath } from '../../../lib/api/errors'
import type { LiveChange } from '../../../record-panels/model'
import {
  TILES,
  type Candidates,
  type InvoiceCounts,
  type InvoiceLine,
  type InvoiceQuery,
  type InvoiceRow,
  type InvoiceStatus,
  type MappingInput,
  type MatchStatus,
  type SupplierInvoice,
  type Tile,
  type Verdict,
} from './api'

/**
 * Finance › Supplier invoices (SCR-153), its record and the PO's Invoices tab: the pure rules — who may do what (the page
 * with payables.view; amounts only with the cost grain), the list's address (`?tile=&q=&new=1`) as the API's query, the
 * tiles' counts, the tones and the words' keys of the API's codes, which rows a bulk approval may take, a line's mapping
 * as a Combobox value and back, the record's tabs, the API's refusals (`refusal/<CODE>`) in this page's words, and the live
 * events that touch the page. No fetching, no React: the tests hold them. No person is counted or totalled.
 */

export const PAYABLES_NAMESPACE = 'finance-payables'

export interface Phrase {
  readonly key: string
  readonly params?: Record<string, string | number>
}

export interface PayablesCan {
  /** The page, the record, the PO tab (GET /payables/invoices…): payables.view. */
  readonly view: boolean
  /** Register a typed invoice, map lines, match again, send to the buyer, dispute, reopen, void, pick up from SDI. */
  readonly manage: boolean
  /** Accept a difference in words. */
  readonly accept: boolean
  readonly approve: boolean
  readonly pay: boolean
  /** Every amount and price is a cost. */
  readonly cost: boolean
  /** "Add foreign invoice" puts its PDF on the supplier first. */
  readonly upload: boolean
  /** A PO line opens its order (purchasing.view). */
  readonly purchasing: boolean
}

export function payablesCanOf(permissions: readonly string[]): PayablesCan {
  const held = new Set(permissions)
  return {
    view: held.has('payables.view'),
    manage: held.has('payables.manage'),
    accept: held.has('payables.differences.accept'),
    approve: held.has('payables.approve'),
    pay: held.has('payables.pay'),
    cost: held.has('money.cost'),
    upload: held.has('files.upload'),
    purchasing: held.has('purchasing.view'),
  }
}

// ---- the list's address -------------------------------------------------------------------------------------------------------

export interface PayablesAddress {
  readonly tile: Tile | null
  readonly q: string | null
  /** "Add foreign invoice" open. */
  readonly adding: boolean
}

export function addressOf(params: { get(name: string): string | null } | null): PayablesAddress {
  const tile = params?.get('tile') ?? null
  const q = params?.get('q')?.trim() ?? ''
  return { tile: tile && (TILES as readonly string[]).includes(tile) ? (tile as Tile) : null, q: q ? q.slice(0, 100) : null, adding: params?.get('new') === '1' }
}

export function payablesHref(prefix: string, address: PayablesAddress): string {
  const query = new URLSearchParams()
  if (address.tile) query.set('tile', address.tile)
  if (address.q) query.set('q', address.q)
  if (address.adding) query.set('new', '1')
  const qs = query.toString()
  return `${prefix}/finance/payables${qs ? `?${qs}` : ''}`
}

export const invoiceHref = (prefix: string, invoiceId: string, tab?: RecordTab): string => `${prefix}/finance/payables/${encodeURIComponent(invoiceId)}${tab ? `?tab=${tab}` : ''}`
export const xmlHref = (prefix: string, invoiceId: string): string => `${prefix}/finance/payables/${encodeURIComponent(invoiceId)}/xml`
export const orderHref = (prefix: string, orderId: string): string => `${prefix}/purchasing/orders/${encodeURIComponent(orderId)}`

export const queryOf = (address: PayablesAddress, companyId: string | null, cursor: string | null = null): InvoiceQuery => ({ companyId, tile: address.tile, q: address.q, cursor, limit: 50 })

/** The tiles in the design's order with their count (null: not known yet → '—', never 0). */
export function tilesOf(counts: InvoiceCounts | null): { id: Tile; count: number | null }[] {
  const pick: Record<Tile, keyof InvoiceCounts> = { NEW_FROM_SDI: 'newFromSdi', DIFFERENCES: 'differences', TO_APPROVE: 'toApprove', DUE_THIS_WEEK: 'dueThisWeek' }
  return TILES.map((id) => ({ id, count: counts ? (counts[pick[id]] as number) : null }))
}

// ---- tones ---------------------------------------------------------------------------------------------------------------------

type Tone = 'neutral' | 'info' | 'success' | 'warning' | 'danger'

export const STATUS_TONE: Readonly<Record<InvoiceStatus, Tone>> = { RECEIVED: 'info', APPROVED: 'success', PAID: 'success', DISPUTED: 'warning', VOIDED: 'neutral' }
export const MATCH_TONE: Readonly<Record<MatchStatus, Tone>> = { PENDING: 'neutral', MATCHED: 'success', DIFFERENCES: 'warning', NO_PO: 'info', WAITING_GOODS: 'warning' }
export const VERDICT_TONE: Readonly<Record<Verdict, Tone>> = { WITHIN: 'success', DIFFERENCE: 'warning', WAITING: 'info' }

/** Only a received invoice is approved: the others carry the reason on their box (a bulk approval never takes them). */
export function rowHeld(row: Pick<InvoiceRow, 'status'>): string | null {
  if (row.status === 'RECEIVED') return null
  return `held.row.${row.status}`
}

/** The invoice is due before (or on) `today` and not paid: late by n days; null when not late. */
export function daysLate(row: Pick<InvoiceRow, 'dueDate' | 'paidOn' | 'status'>, today: string): number | null {
  if (!row.dueDate || row.paidOn || row.status === 'VOIDED' || row.status === 'PAID') return null
  const days = Math.round((Date.parse(`${today}T00:00:00Z`) - Date.parse(`${row.dueDate}T00:00:00Z`)) / 86_400_000)
  return days > 0 ? days : null
}

// ---- a line's mapping ------------------------------------------------------------------------------------------------------------

export interface MappingOption {
  readonly value: string
  readonly label: string
}

/** The line's mapping as the Combobox's value: a PO line, a subcontract order, a service or a charge; '' while not mapped. */
export function mappingValue(line: Pick<InvoiceLine, 'kind' | 'purchaseOrderLine' | 'subcontractOrder'>): string {
  if (line.purchaseOrderLine) return `pol:${line.purchaseOrderLine.id}`
  if (line.subcontractOrder) return `sco:${line.subcontractOrder.id}`
  if (line.kind === 'SERVICE' || line.kind === 'CHARGE') return `kind:${line.kind}`
  return ''
}

/** What PATCH …/lines/:id takes for a Combobox value (null: not a value we know). */
export function mappingInputOf(value: string): MappingInput | null {
  const [kind, id] = value.split(':')
  if (!id) return null
  if (kind === 'pol') return { purchaseOrderLineId: id }
  if (kind === 'sco') return { subcontractOrderId: id }
  if (kind === 'kind' && (id === 'SERVICE' || id === 'CHARGE')) return { kind: id, purchaseOrderLineId: null, subcontractOrderId: null }
  return null
}

export interface MappingWords {
  readonly poLine: (order: string, seq: number, item: string, quantity: string) => string
  readonly subcontract: (order: string) => string
  readonly service: string
  readonly charge: string
}

/** The Combobox's options: the supplier's PO lines and subcontract orders the line may bill, then "a service", "a charge". */
export function mappingOptions(candidates: Candidates | null, line: Pick<InvoiceLine, 'kind' | 'purchaseOrderLine' | 'subcontractOrder'>, words: MappingWords): MappingOption[] {
  const options: MappingOption[] = []
  for (const entry of candidates?.purchaseOrderLines ?? [])
    options.push({ value: `pol:${entry.id}`, label: words.poLine(entry.orderNumber, entry.seq, `${entry.item.code} ${entry.item.name}`, `${entry.quantity} ${entry.uom}`) })
  for (const entry of candidates?.subcontractOrders ?? []) options.push({ value: `sco:${entry.id}`, label: words.subcontract(entry.number) })
  // The line's own mapping stays offered while the candidates are read (or when the order is no longer open to bill).
  if (line.purchaseOrderLine && !options.some((option) => option.value === `pol:${line.purchaseOrderLine!.id}`)) {
    const own = line.purchaseOrderLine
    options.unshift({ value: `pol:${own.id}`, label: words.poLine(own.orderNumber, own.seq, `${own.item.code} ${own.item.name}`, `${own.quantity} ${own.uom}`) })
  }
  if (line.subcontractOrder && !options.some((option) => option.value === `sco:${line.subcontractOrder!.id}`))
    options.unshift({ value: `sco:${line.subcontractOrder.id}`, label: words.subcontract(line.subcontractOrder.number) })
  options.push({ value: 'kind:SERVICE', label: words.service }, { value: 'kind:CHARGE', label: words.charge })
  return options
}

/** Goods or subcontract lines still without an order (the "invoice without PO" offer). */
export const unmappedLines = (invoice: Pick<SupplierInvoice, 'lines'>): number =>
  invoice.lines.filter((line) => (line.kind === 'GOODS' || line.kind === 'SUBCONTRACT') && !line.purchaseOrderLine && !line.subcontractOrder).length

// ---- the record ----------------------------------------------------------------------------------------------------------------

export const RECORD_TABS = ['lines', 'match', 'approval', 'payment', 'activity'] as const
export type RecordTab = (typeof RECORD_TABS)[number]
export const tabOf = (value: string | null | undefined): RecordTab => ((RECORD_TABS as readonly string[]).includes(value ?? '') ? (value as RecordTab) : 'lines')

/** The approval's problems, every code the API answers (factory-domain payables/rules approvalProblems). */
export const APPROVAL_CODES = ['NOT_RECEIVED', 'OWN_INVOICE', 'NO_LINES', 'NOT_MATCHED', 'WAITING_GOODS', 'DIFFERENCES', 'NO_XML', 'LINES_DO_NOT_ADD_UP'] as const
/** Every `refusal/<CODE>` the payables routes answer (modules/payables invoices, approval, sdi). */
export const REFUSAL_CODES = [
  ...APPROVAL_CODES,
  'NOT_APPROVED',
  'NOT_OPEN',
  'FROM_SDI',
  'COMES_THROUGH_SDI',
  'DUPLICATE',
  'NOTHING_UNMAPPED',
  'NOT_ALLOWED_NOW',
  'WITHIN_TOLERANCE',
  'ACCEPTED',
  'NO_DIFFERENCES',
  'THREAD_CLOSED',
  'NOT_A_CREDIT_NOTE',
  'VOIDED',
  'OTHER_SUPPLIER',
  'NOT_ACCEPTED_FOR_CREDIT',
  'NO_INTERMEDIARY',
  'INTERMEDIARY_UNAVAILABLE',
  'NO_SDI_ACCOUNT',
] as const
export type RefusalCode = (typeof REFUSAL_CODES)[number]

/** A refusal in our words: a known code has its own sentence; an unknown one a general one (never the API's English). */
export const refusalPhrase = (code: string): Phrase => ((REFUSAL_CODES as readonly string[]).includes(code) ? { key: `refusal.${code}` } : { key: 'refusal.other' })

/** The refusals an API error carries (409, issues `refusal/<CODE>`), in order, each once. */
export function refusalsOf(error: unknown): string[] {
  if (!isApiError(error)) return []
  const codes: string[] = []
  for (const issue of error.issues) {
    const path = issuePath(issue)
    const at = path.indexOf('refusal/')
    if (at < 0) continue
    const code = path.slice(at + 'refusal/'.length).split('/')[0]!
    if (code && !codes.includes(code)) codes.push(code)
  }
  return codes
}

export interface WriteProblem {
  readonly phrases: readonly Phrase[]
  /** The invoice changed meanwhile: read it again. */
  readonly reload: boolean
}

/** A refused write in this page's words: its refusals, a moved record, a field the API refused, or the kind of failure. */
export function writeProblem(error: unknown): WriteProblem {
  if (!isApiError(error)) return { phrases: [{ key: 'problem.write.internal' }], reload: false }
  const refusals = refusalsOf(error)
  if (refusals.length > 0) return { phrases: refusals.map(refusalPhrase), reload: error.kind === 'conflict' }
  const paths = error.issues.map(issuePath)
  if (error.kind === 'conflict' && paths.some((path) => path.split(/[./]/).includes('version'))) return { phrases: [{ key: 'problem.write.moved' }], reload: true }
  if (error.kind === 'conflict') return { phrases: [{ key: 'problem.write.state' }], reload: true }
  if (error.kind === 'invalid') {
    if (paths.some((path) => path.includes('paidOn'))) return { phrases: [{ key: 'problem.write.paidOn' }], reload: false }
    if (paths.some((path) => path.includes('purchaseOrderLineId') || path.includes('subcontractOrderId') || path.includes('kind')))
      return { phrases: [{ key: 'problem.write.mapping' }], reload: false }
    if (paths.some((path) => path.includes('lines'))) return { phrases: [{ key: 'problem.write.lines' }], reload: false }
    return { phrases: [{ key: 'problem.write.invalid' }], reload: false }
  }
  if (['signed_out', 'forbidden', 'not_found', 'rate_limited', 'unavailable'].includes(error.kind)) return { phrases: [{ key: `problem.write.${error.kind}` }], reload: error.kind === 'not_found' }
  return { phrases: [{ key: 'problem.write.internal' }], reload: false }
}

export function readProblem(error: unknown): string {
  if (!isApiError(error)) return 'problem.read.internal'
  if (['signed_out', 'forbidden', 'not_found', 'unavailable', 'rate_limited'].includes(error.kind)) return `problem.read.${error.kind}`
  return 'problem.read.internal'
}

/** A live event that may change the page: any supplier invoice's, or a pickup. */
export const liveTouches = (change: Pick<LiveChange, 'type'>): boolean => change.type.startsWith('supplier_invoice.')

/** A live event about this invoice (its id in the fields), or one that rematches invoices (a receipt). */
export function recordTouched(change: LiveChange, invoiceId: string): boolean {
  if (!change.type.startsWith('supplier_invoice.')) return change.type === 'inventory.receipt_posted' || change.type === 'inventory.receipt_reversed' || change.type === 'subcontract_order.received'
  const fields = change.fields
  return fields.invoiceId === invoiceId || fields.subject === invoiceId || fields.id === invoiceId || fields.supplierInvoiceId === invoiceId
}

// ---- dialogs' checks ------------------------------------------------------------------------------------------------------------

/** Why "Mark paid" may not be sent as typed (null: it may): a day from the invoice's to today, a bank reference. */
export function payProblem(input: { paidOn: string; paymentRef: string }, invoice: Pick<SupplierInvoice, 'issueDate'>, today: string): string | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.paidOn)) return 'pay.problem.day'
  if (input.paidOn > today) return 'pay.problem.future'
  if (input.paidOn < invoice.issueDate) return 'pay.problem.beforeIssue'
  if (input.paymentRef.trim() === '') return 'pay.problem.ref'
  return null
}

/** A typed amount ("1.250,50", "1250.50") as minor units (0 allowed for VAT); null when it is not one. */
export function amountOf(text: string, allowZero = false): number | null {
  const trimmed = text.trim().replace(/\s/g, '').replace(/^€/, '').replace(/€$/, '')
  if (trimmed === '') return null
  const normalised = /,\d{1,2}$/.test(trimmed) ? trimmed.replace(/\./g, '').replace(',', '.') : trimmed.replace(/,/g, '')
  if (!/^\d{1,9}(\.\d{1,2})?$/.test(normalised)) return null
  const minor = Math.round(Number(normalised) * 100)
  return minor > 0 || (allowZero && minor === 0) ? minor : null
}

/** A typed decimal ("12,5") as the API takes it ("12.5"), up to `places` decimals; null when it is not one above 0. */
export function decimalOf(text: string, places = 4): string | null {
  const trimmed = text.trim().replace(/\s/g, '')
  if (trimmed === '') return null
  const normalised = trimmed.includes(',') ? trimmed.replace(/\./g, '').replace(',', '.') : trimmed
  if (!new RegExp(`^\\d{1,9}(\\.\\d{1,${places}})?$`).test(normalised)) return null
  return Number(normalised) > 0 ? normalised : null
}

export interface ForeignDraft {
  readonly partyId: string | null
  readonly country: string | null
  readonly kind: 'INVOICE' | 'CREDIT_NOTE'
  readonly number: string
  readonly issueDate: string
  readonly currency: string
  readonly dueDate: string
  readonly description: string
  readonly net: string
  readonly vatRate: string
  readonly vatNature: string
  readonly vat: string
  readonly fileName: string | null
  readonly note: string
}

export const EMPTY_FOREIGN: ForeignDraft = Object.freeze({
  partyId: null,
  country: null,
  kind: 'INVOICE',
  number: '',
  issueDate: '',
  currency: 'EUR',
  dueDate: '',
  description: '',
  net: '',
  vatRate: '0',
  vatNature: 'N2.1',
  vat: '0',
  fileName: null,
  note: '',
})

/** What "Add foreign invoice" still misses (message keys; empty: it may be sent). An Italian supplier's comes through SDI. */
export function foreignProblems(draft: ForeignDraft, today: string): string[] {
  const problems: string[] = []
  if (!draft.partyId) problems.push('foreign.problem.supplier')
  else if (draft.country === 'IT') problems.push('refusal.COMES_THROUGH_SDI')
  if (draft.number.trim() === '') problems.push('foreign.problem.number')
  if (!/^\d{4}-\d{2}-\d{2}$/.test(draft.issueDate) || draft.issueDate > today) problems.push('foreign.problem.issueDate')
  if (!/^[A-Z]{3}$/.test(draft.currency)) problems.push('foreign.problem.currency')
  if (draft.description.trim() === '') problems.push('foreign.problem.description')
  if (amountOf(draft.net) === null) problems.push('foreign.problem.net')
  if (!/^\d{1,3}([.,]\d{1,2})?$/.test(draft.vatRate.trim())) problems.push('foreign.problem.vatRate')
  if (amountOf(draft.vat, true) === null) problems.push('foreign.problem.vat')
  if (Number(draft.vatRate.replace(',', '.')) === 0 && !/^N[1-7](\.[0-9])?$/.test(draft.vatNature.trim())) problems.push('foreign.problem.vatNature')
  if (!draft.fileName) problems.push('foreign.problem.file')
  return problems
}

// ---- held actions in our words ------------------------------------------------------------------------------------------------

export type HeldAction = 'edit' | 'map' | 'dispute' | 'reopen' | 'withdraw' | 'pay' | 'void'

/**
 * Whether the API holds an action on the invoice now (its `actions.*`, the truth) and why, in this page's words (the API's
 * sentences are English: never shown). An SDI invoice's text and existence never change; otherwise the state decides.
 */
export function actionHeld(invoice: Pick<SupplierInvoice, 'actions' | 'source'>, action: HeldAction): Phrase | null {
  if (invoice.actions[action] === null) return null
  if ((action === 'edit' || action === 'void') && invoice.source === 'SDI') return { key: `held.${action}Sdi` }
  return { key: `held.${action}` }
}
