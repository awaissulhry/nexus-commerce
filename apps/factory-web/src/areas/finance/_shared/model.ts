import { isApiError, issuePath } from '../../../lib/api/errors'
import { formatNumber } from '../../../lib/i18n/format'
import type { Locale } from '../../../lib/i18n/locales'
import {
  INVOICE_DOC_TYPES,
  INVOICE_STATUSES,
  type AllocationTarget,
  type Checks,
  type CreditReason,
  type Deadline,
  type DocType,
  type Invoice,
  type InvoiceLine,
  type InvoiceQuery,
  type InvoiceRow,
  type InvoiceStatus,
  type OpenItem,
  type Payment,
  type PaymentRow,
  type Sdi,
  type SdiFix,
  type SdiStateCode,
} from './api'

/**
 * The Finance screens' pure rules (SCR-080 invoices, SCR-081 the invoice record, SCR-082 payments, SCR-083 settings): what
 * a person may do (permissions) and see (grains: Finance sees amounts; without money.price no amount is drawn), the saved
 * rows and the address that holds them, where an invoice stands (its journey: draft → checks → issued → SDI → delivered →
 * paid), the next step by state and why it waits, the checks before issue in words with where to fix each, the payment
 * state (unpaid, part paid, paid, overdue), how a payment is placed (oldest first, never above what an item asks), the
 * CSV by grain, and the API's errors as this app's words. No fetching, no React: the tests hold them.
 */

export type Tone = 'neutral' | 'info' | 'success' | 'warning' | 'danger'

/** A message key and its values, translated by the view (`finance` catalogue). */
export interface Phrase {
  key: string
  params?: Record<string, string | number>
}
const phrase = (key: string, params?: Record<string, string | number>): Phrase => (params ? { key, params } : { key })

export interface FinanceAbilities {
  viewInvoices: boolean
  /** Drafts: from DDTs, lines and text, credit notes, delete. */
  manageInvoices: boolean
  /** Issue, send to SDI, fix and resend (each with a fresh step-up). */
  issueInvoices: boolean
  viewPayments: boolean
  recordPayments: boolean
  voidPayments: boolean
  viewOrders: boolean
  viewParties: boolean
  viewBank: boolean
  manageBank: boolean
  viewCompanies: boolean
  manageCompanies: boolean
  viewIntegrations: boolean
  viewNumbering: boolean
  /** The thread's mail (a copy of the invoice to the customer). */
  email: boolean
  price: boolean
}

export function abilitiesOf(permissions: readonly string[]): FinanceAbilities {
  const held = new Set(permissions)
  return {
    viewInvoices: held.has('invoices.view'),
    manageInvoices: held.has('invoices.manage'),
    issueInvoices: held.has('invoices.issue'),
    viewPayments: held.has('payments.view'),
    recordPayments: held.has('payments.record'),
    voidPayments: held.has('payments.void'),
    viewOrders: held.has('orders.view'),
    viewParties: held.has('parties.view'),
    viewBank: held.has('companies.bank.view'),
    manageBank: held.has('companies.bank.manage'),
    viewCompanies: held.has('companies.view'),
    manageCompanies: held.has('companies.manage'),
    viewIntegrations: held.has('integrations.view'),
    viewNumbering: held.has('numbering.view'),
    email: held.has('email.send'),
    price: held.has('money.price'),
  }
}

// ---- dates and money ---------------------------------------------------------------------------------------------------------

/** Today in Rome (the sites' default zone), as YYYY-MM-DD. */
export function romeToday(now: Date = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Rome', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now)
}

/** A business day (YYYY-MM-DD) as an instant at noon UTC, so it formats as the same day in Rome. */
export const dayInstant = (day: string): string => `${day}T12:00:00Z`

/** Whole days from `from` to `to` (YYYY-MM-DD; negative when `to` is earlier). */
export function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000)
}

/** Minor units in the person's language with the currency (`1.234,50 €`); '—' when the grain hides it. */
export function money(minor: number | null | undefined, currency: string, locale: Locale): string {
  if (minor === null || minor === undefined) return '—'
  return formatNumber(minor / 100, locale, { style: 'currency', currency })
}

/** A unit price as the API writes it ("450", "12.5") with 2 to 4 decimals. */
export function unitPrice(value: string | null | undefined, currency: string, locale: Locale): string {
  if (value === null || value === undefined || value === '') return '—'
  const number = Number(value)
  if (!Number.isFinite(number)) return '—'
  return formatNumber(number, locale, { style: 'currency', currency, minimumFractionDigits: 2, maximumFractionDigits: 4 })
}

/** A decimal the API writes as text ("2.0000", "22.00") without its trailing zeros, in the person's language. */
export function decimal(value: string | null | undefined, locale: Locale, maximumFractionDigits = 4): string {
  if (value === null || value === undefined || value === '') return '—'
  const number = Number(value)
  return Number.isFinite(number) ? formatNumber(number, locale, { maximumFractionDigits }) : value
}

/** A typed amount in either language's way ("1.250,50", "1250.50", "€ 1250") as minor units; null when it is not one above 0. */
export function parseAmount(text: string): number | null {
  const trimmed = text.trim().replace(/\s/g, '').replace(/^€/, '').replace(/€$/, '')
  if (trimmed === '') return null
  const normalised = /,\d{1,2}$/.test(trimmed) ? trimmed.replace(/\./g, '').replace(',', '.') : trimmed.replace(/,/g, '')
  if (!/^\d{1,9}(\.\d{1,2})?$/.test(normalised)) return null
  const minor = Math.round(Number(normalised) * 100)
  return minor > 0 ? minor : null
}

/** A typed unit price ("450,50", "450.5") as the API takes it (a decimal string, up to 6 decimals), or null. */
export function parsePrice(text: string): string | null {
  const trimmed = text.trim().replace(/\s/g, '').replace(/^€/, '').replace(/€$/, '')
  if (trimmed === '') return null
  const normalised = /,\d{1,6}$/.test(trimmed) ? trimmed.replace(/\./g, '').replace(',', '.') : trimmed.replace(/,/g, '')
  return /^\d{1,9}(\.\d{1,6})?$/.test(normalised) ? normalised : null
}

/** A typed quantity above 0 with at most 4 decimals, or null. */
export function parseQuantity(text: string): string | null {
  const normalised = text.trim().replace(',', '.')
  if (!/^\d{1,9}(\.\d{1,4})?$/.test(normalised) || Number(normalised) <= 0) return null
  return normalised
}

/** Minor units as a plain number to type over ("1872.00" / "1872,00"). */
export const amountText = (minor: number, locale: Locale): string => (minor / 100).toFixed(2).replace('.', locale === 'it' ? ',' : '.')

/** A decimal the API writes ("450.000000") as a plain number to type over, in the person's language. */
export const priceText = (value: string, locale: Locale): string => {
  const number = Number(value)
  if (!Number.isFinite(number)) return value
  const text = String(Math.round(number * 1_000_000) / 1_000_000)
  return locale === 'it' ? text.replace('.', ',') : text
}

// ---- invoice words and tones ------------------------------------------------------------------------------------------------

export const STATUS_TONE: Record<InvoiceStatus, Tone> = { DRAFT: 'neutral', ISSUED: 'warning', SENT: 'info', DELIVERED: 'success', NOT_DELIVERABLE: 'warning', REJECTED: 'danger', ERROR: 'danger' }

export const SDI_TONE: Record<SdiStateCode, Tone> = { DRAFT: 'neutral', NOT_SENT: 'warning', SENDING: 'info', AT_SDI: 'info', DELIVERED: 'success', NOT_DELIVERED: 'warning', REJECTED: 'danger', ERROR: 'danger' }

/** Where an invoice stands with SDI, from its own status (the list has no SDI read per row; the record has the full one). */
export function sdiCodeOf(status: InvoiceStatus): SdiStateCode {
  switch (status) {
    case 'DRAFT':
      return 'DRAFT'
    case 'ISSUED':
      return 'NOT_SENT'
    case 'SENT':
      return 'AT_SDI'
    case 'DELIVERED':
      return 'DELIVERED'
    case 'NOT_DELIVERABLE':
      return 'NOT_DELIVERED'
    case 'REJECTED':
      return 'REJECTED'
    default:
      return 'ERROR'
  }
}

/** A credit note or a deposit invoice is not paid on its own: TD04 asks nothing, a TD02 is paid through its deposit. */
export const PAYABLE: readonly DocType[] = ['TD01', 'TD24']

export type PayState = 'NONE' | 'BY_DEPOSIT' | 'CREDIT' | 'UNPAID' | 'PART_PAID' | 'PAID' | 'OVERDUE'

export const PAY_TONE: Record<PayState, Tone> = { NONE: 'neutral', BY_DEPOSIT: 'neutral', CREDIT: 'neutral', UNPAID: 'warning', PART_PAID: 'info', PAID: 'success', OVERDUE: 'danger' }

/**
 * Whether an invoice is paid (A2 SCR-080 "Payment: Unpaid · Part paid · Paid · Overdue 12 days"): null without the price
 * grain (the column is not drawn). A draft is nothing yet; a TD02 is paid by its deposit; a TD04 asks nothing.
 */
export function payStateOf(invoice: Pick<InvoiceRow, 'docType' | 'status' | 'paidAmount' | 'openAmount' | 'dueDate'>, today: string): { state: PayState; days: number } | null {
  if (invoice.status === 'DRAFT') return { state: 'NONE', days: 0 }
  if (invoice.docType === 'TD02') return { state: 'BY_DEPOSIT', days: 0 }
  if (invoice.docType === 'TD04') return { state: 'CREDIT', days: 0 }
  if (invoice.openAmount === undefined) return null
  if (invoice.openAmount <= 0) return { state: 'PAID', days: 0 }
  if (invoice.dueDate && invoice.dueDate < today) return { state: 'OVERDUE', days: daysBetween(invoice.dueDate, today) }
  return { state: (invoice.paidAmount ?? 0) > 0 ? 'PART_PAID' : 'UNPAID', days: 0 }
}

/** The invoice's due date from its payment terms (the first instalment that has one). */
export function dueDateOf(invoice: Pick<Invoice, 'paymentTerms'>): string | null {
  return invoice.paymentTerms?.installments?.find((installment) => typeof installment.dueDate === 'string')?.dueDate ?? null
}

/** How the record is called: its number, else "Draft …". */
export const isFinal = (invoice: Pick<Invoice, 'status'>): boolean => invoice.status !== 'DRAFT'

// ---- the saved rows, the address, the API query (one filter model) ------------------------------------------------------------

export const ROW_VIEWS = ['all', 'drafts', 'atSdi', 'rejected', 'notDelivered', 'creditNotes', 'depositInvoices'] as const
export type RowView = (typeof ROW_VIEWS)[number]

const ROW_QUERY: Record<RowView, InvoiceQuery> = {
  all: {},
  drafts: { status: 'DRAFT' },
  atSdi: { status: 'SENT' },
  rejected: { status: 'REJECTED' },
  notDelivered: { status: 'NOT_DELIVERABLE' },
  creditNotes: { docType: 'TD04' },
  depositInvoices: { docType: 'TD02' },
}

const isStatus = (value: string | null | undefined): value is InvoiceStatus => !!value && (INVOICE_STATUSES as readonly string[]).includes(value)
const isDocType = (value: string | null | undefined): value is DocType => !!value && (INVOICE_DOC_TYPES as readonly string[]).includes(value)

/**
 * The rows the address asks for, in the API's own filter names (`?status=REJECTED`, `?docType=TD04`): Home › Today's
 * links and the tiles land here. A status or type no saved view names keeps its own filter (`custom`).
 */
export function queryFromAddress(params: { get(name: string): string | null } | null): { rows: RowView | 'custom'; query: InvoiceQuery } {
  const status = params?.get('status') ?? null
  const docType = params?.get('docType') ?? null
  const query: InvoiceQuery = { ...(isStatus(status) ? { status } : {}), ...(isDocType(docType) ? { docType } : {}) }
  const rows = (ROW_VIEWS as readonly RowView[]).find((view) => {
    const known = ROW_QUERY[view]
    return (known.status ?? null) === (query.status ?? null) && (known.docType ?? null) === (query.docType ?? null)
  })
  return { rows: rows ?? 'custom', query }
}

export const rowsQuery = (rows: RowView): InvoiceQuery => ROW_QUERY[rows]

/** The list's address for a saved rows view (the API's filter names). */
export function invoicesAddress(base: string, rows: RowView): string {
  const query = ROW_QUERY[rows]
  const search = new URLSearchParams({ ...(query.status ? { status: query.status } : {}), ...(query.docType ? { docType: query.docType } : {}) }).toString()
  return search ? `${base}?${search}` : base
}

/** The tiles (A2 SCR-080 "Where invoices stand"): each a saved rows view, but the first, which is its own section. */
export const TILES = [
  { key: 'shipped', rows: null },
  { key: 'drafts', rows: 'drafts' },
  { key: 'atSdi', rows: 'atSdi' },
  { key: 'rejected', rows: 'rejected' },
  { key: 'notDelivered', rows: 'notDelivered' },
] as const satisfies ReadonlyArray<{ key: string; rows: RowView | null }>
export type TileKey = (typeof TILES)[number]['key']

/** A count read with a limit: the limit reached reads "200+". */
export const countText = (count: number | null, limit = 200): string => (count === null ? '—' : count >= limit ? `${limit}+` : String(count))

// ---- shipped, not invoiced --------------------------------------------------------------------------------------------------------

/** What a DDT still has to invoice (shipped less issued, less what sits in drafts). */
export function ddtLeft(ddt: { lines: ReadonlyArray<{ notInvoiced: string; inDraft: string }> }): { toInvoice: number; inDraft: number } {
  let toInvoice = 0
  let inDraft = 0
  for (const line of ddt.lines) {
    const draft = Number(line.inDraft) || 0
    const open = Number(line.notInvoiced) || 0
    inDraft += draft
    toInvoice += Math.max(0, open - draft)
  }
  return { toInvoice, inDraft }
}

/** Why a DDT row cannot be chosen for a new invoice (everything left of it is in a draft already), or null. */
export function ddtHeld(ddt: { lines: ReadonlyArray<{ notInvoiced: string; inDraft: string }> }): Phrase | null {
  return ddtLeft(ddt).toInvoice > 0 ? null : phrase('held.ddtInDraft')
}

/** The deadline in words: by when, how many days, late. */
export function deadlineWords(deadline: Pick<Deadline, 'docType' | 'dueBy' | 'daysLeft' | 'state'>): Phrase {
  if (deadline.state === 'LATE') return phrase(`deadline.late.${deadline.docType}`, { count: Math.abs(deadline.daysLeft) })
  return phrase(`deadline.left.${deadline.docType}`, { count: deadline.daysLeft })
}

export const DEADLINE_TONE: Record<Deadline['state'], Tone> = { OPEN: 'neutral', DUE_SOON: 'warning', LATE: 'danger' }

/**
 * Why the selected DDTs cannot become one invoice (one customer and company, one calendar month for a TD24), or null.
 * The API checks again; this says it before the click.
 */
export function selectionHeld(ddts: ReadonlyArray<{ partyId: string; companyId: string; date: string; lines: ReadonlyArray<{ notInvoiced: string; inDraft: string }> }>): Phrase | null {
  if (ddts.length === 0) return phrase('held.noDdt')
  const first = ddts[0]!
  if (ddts.some((ddt) => ddt.partyId !== first.partyId || ddt.companyId !== first.companyId)) return phrase('held.oneCustomer')
  if (new Set(ddts.map((ddt) => ddt.date.slice(0, 7))).size > 1) return phrase('held.oneMonth')
  if (ddts.some((ddt) => ddtHeld(ddt) !== null)) return phrase('held.ddtInDraft')
  return null
}

/** The type the rule suggests for these DDTs together: one DDT in its 12 days → TD01; else TD24 (one month). */
export function suggestedType(ddts: ReadonlyArray<{ immediate: Pick<Deadline, 'state'> }>): 'TD01' | 'TD24' {
  return ddts.length === 1 && ddts[0]!.immediate.state !== 'LATE' ? 'TD01' : 'TD24'
}

// ---- the record: journey, next step, checks --------------------------------------------------------------------------------------

export type StepState = 'done' | 'current' | 'todo' | 'problem' | 'skipped'

export interface JourneyStep {
  key: 'draft' | 'checks' | 'issued' | 'sdi' | 'delivered' | 'paid'
  state: StepState
}

/** Draft → Checks → Issued (number) → SDI accepted → Delivered (or not delivered: in the tax drawer) → Paid. */
export function journeyOf(invoice: Pick<Invoice, 'status' | 'docType' | 'openAmount'>, checks: Pick<Checks, 'ready'> | null): JourneyStep[] {
  const status = invoice.status
  const issued = status !== 'DRAFT'
  const atSdi = ['SENT', 'DELIVERED', 'NOT_DELIVERABLE', 'REJECTED', 'ERROR'].includes(status)
  const reached = status === 'DELIVERED' || status === 'NOT_DELIVERABLE'
  const payable = PAYABLE.includes(invoice.docType)
  const paid = reached && payable && invoice.openAmount !== undefined && invoice.openAmount <= 0
  return [
    { key: 'draft', state: issued ? 'done' : 'current' },
    { key: 'checks', state: issued ? 'done' : checks === null ? 'todo' : checks.ready ? 'done' : 'problem' },
    { key: 'issued', state: issued ? 'done' : 'todo' },
    { key: 'sdi', state: status === 'REJECTED' || status === 'ERROR' ? 'problem' : status === 'SENT' ? 'current' : atSdi ? 'done' : issued ? 'current' : 'todo' },
    { key: 'delivered', state: status === 'NOT_DELIVERABLE' ? 'problem' : reached ? 'done' : 'todo' },
    { key: 'paid', state: !payable ? 'skipped' : paid ? 'done' : reached ? 'current' : 'todo' },
  ]
}

export type NextKind = 'issue' | 'send' | 'fix' | 'sendAgain' | 'recordPayment'

/** The band's primary by state, and why it waits for this person (or null). */
export function nextStepOf(invoice: Pick<Invoice, 'status' | 'docType' | 'openAmount' | 'filesPending'>, sdi: Pick<Sdi, 'state' | 'canSend'> | null, can: FinanceAbilities, checks: Pick<Checks, 'ready' | 'problems'> | null): { kind: NextKind | null; held: Phrase | null } {
  const status = invoice.status
  if (status === 'DRAFT') {
    if (!can.issueInvoices) return { kind: 'issue', held: phrase('held.noIssue') }
    if (checks === null) return { kind: 'issue', held: phrase('held.checksReading') }
    if (!checks.ready) return { kind: 'issue', held: phrase('held.checksFail', { count: checks.problems.length }) }
    return { kind: 'issue', held: null }
  }
  const action = sdi?.state.next.action ?? null
  if (status === 'REJECTED' || action === 'FIX_AND_RESEND') return { kind: 'fix', held: can.issueInvoices ? null : phrase('held.noIssue') }
  if (status === 'ISSUED' || action === 'SEND') return { kind: 'send', held: !can.issueInvoices ? phrase('held.noIssue') : sdi && !sdi.canSend ? phrase('held.sdiNotNow') : null }
  if (status === 'ERROR' || action === 'SEND_AGAIN') return { kind: 'sendAgain', held: !can.issueInvoices ? phrase('held.noIssue') : sdi && !sdi.canSend ? phrase('held.sdiNotNow') : null }
  if ((status === 'DELIVERED' || status === 'NOT_DELIVERABLE' || status === 'SENT') && PAYABLE.includes(invoice.docType) && (invoice.openAmount ?? 0) > 0) {
    return { kind: 'recordPayment', held: can.recordPayments ? null : phrase('held.noRecord') }
  }
  return { kind: null, held: null }
}

/** Where a failed check is fixed (the check list's Fix link). */
export type CheckFix = 'party' | 'company' | 'lines' | 'text' | 'deduction' | 'series' | 'none'

/** The check codes this app has words for (factory-domain invoicing/checks, from-shipment/checks, issue.ts). */
export const CHECK_CODES = [
  'PARTY_BLOCKED',
  'PARTY_ARCHIVED',
  'PARTY_WARNING',
  'NO_VIES_PROOF',
  'CURRENCY',
  'NO_LINES',
  'LINE',
  'TOTALS',
  'SELLER',
  'BUYER',
  'FATTURAPA',
  'DEPOSIT_MISSING',
  'DEPOSIT_STATE',
  'DEPOSIT_CURRENCY',
  'DEPOSIT_OVER_REQUEST',
  'DEPOSIT_ZERO',
  'DDT_CANCELLED',
  'DDT_NOT_SHIPPED',
  'DDT_NOT_CARRIED',
  'DDT_INVOICED',
  'DEDUCTION_STATE',
  'DEDUCTION_OVER',
  'CREDIT_REASON',
  'CREDIT_OF',
  'CREDIT_OVER',
  'SERIES',
] as const

/** A failed check as words and where to fix it (never the API's English). */
export function checkOf(problem: { code: string; path: string }): { key: string; fix: CheckFix } {
  const code = (CHECK_CODES as readonly string[]).includes(problem.code) ? problem.code : 'OTHER'
  const path = problem.path
  let fix: CheckFix = 'none'
  if (code === 'SERIES') fix = 'series'
  else if (code.startsWith('DEDUCTION_') || code.startsWith('DEPOSIT_')) fix = 'deduction'
  else if (code.startsWith('PARTY_') || code === 'NO_VIES_PROOF' || code === 'BUYER' || /^(party|buyer|billTo)/.test(path)) fix = 'party'
  else if (code === 'SELLER' || /^(company|seller)/.test(path)) fix = 'company'
  else if (/causale|documentRefs|payment/.test(path)) fix = 'text'
  else if (code === 'LINE' || code === 'TOTALS' || code === 'NO_LINES' || /lines/.test(path)) fix = 'lines'
  return { key: `check.${code}`, fix }
}

// ---- VAT in words -------------------------------------------------------------------------------------------------------------

/** The Natura codes this app explains (the ones the VAT rules use; others show their code and the law). */
export const NATURA_WORDED = ['N1', 'N2.1', 'N2.2', 'N3.1', 'N3.2', 'N3.3', 'N3.4', 'N3.5', 'N3.6', 'N4', 'N5', 'N6.9', 'N7'] as const

/** A line's VAT as the cell shows it: the rate, or the reason without VAT (its code and a message key). */
export function vatOf(line: Pick<InvoiceLine, 'vatRatePct' | 'vatNature' | 'vatLegalRef'>): { rate: number | null; nature: string | null; key: string | null; law: string | null } {
  if (line.vatNature) {
    const known = (NATURA_WORDED as readonly string[]).includes(line.vatNature)
    return { rate: null, nature: line.vatNature, key: known ? `natura.${line.vatNature.replace('.', '_')}` : null, law: line.vatLegalRef }
  }
  const rate = Number(line.vatRatePct)
  return { rate: Number.isFinite(rate) ? rate : null, nature: null, key: null, law: null }
}

// ---- SDI in words -------------------------------------------------------------------------------------------------------------

/** The NS error codes this app has words for (factory-domain invoicing/sdi/errors SDI_ERROR_CODES). */
export const SDI_ERRORS_WORDED = ['00001', '00002', '00102', '00200', '00301', '00305', '00306', '00311', '00312', '00400', '00401', '00403', '00404', '00409', '00418', '00421', '00422', '00423', '00424', '00425', '00427', '00429', '00430', '00443', '00444'] as const

export const sdiErrorKey = (code: string): string | null => ((SDI_ERRORS_WORDED as readonly string[]).includes(code) ? `sdiError.c${code}` : null)

/** Where an SDI error is fixed, as the check list's fix. */
export const fixOfSdi = (fix: SdiFix): CheckFix => fix

/** The latest NS's errors (the reason of the rejection now), or none. */
export function rejectionOf(sdi: Pick<Sdi, 'sends'>): { at: string; errors: Sdi['sends'][number]['notifications'][number]['errors'] } | null {
  for (const send of [...sdi.sends].sort((a, b) => b.attempt - a.attempt)) {
    const ns = [...send.notifications].reverse().find((notification) => notification.type === 'NS')
    if (ns) return { at: ns.receivedAt, errors: ns.errors }
    if (send.status !== 'REJECTED') return null
  }
  return null
}

// ---- credit notes -----------------------------------------------------------------------------------------------------------

export type CreditMode = 'full' | 'lines' | 'amount'

/** What can still be credited on an invoice (its gross less its issued credit notes); null without the price grain. */
export function creditableOf(invoice: Pick<Invoice, 'grossTotal' | 'creditedAmount'>): number | null {
  if (invoice.grossTotal === undefined) return null
  return Math.max(0, invoice.grossTotal - (invoice.creditedAmount ?? 0))
}

/** Why a credit note of this invoice waits, or null: only an issued TD01/TD24/TD02, never a rejected one. */
export function creditHeld(invoice: Pick<Invoice, 'docType' | 'status' | 'grossTotal' | 'creditedAmount'>, can: FinanceAbilities): Phrase | null {
  if (!can.manageInvoices) return phrase('held.noManage')
  if (invoice.docType === 'TD04') return phrase('held.creditOfCredit')
  if (invoice.status === 'DRAFT') return phrase('held.creditOfDraft')
  if (invoice.status === 'REJECTED') return phrase('held.creditOfRejected')
  const left = creditableOf(invoice)
  if (left !== null && left <= 0) return phrase('held.creditNothingLeft')
  return null
}

/** Problems of the credit note dialog as message keys. */
export function creditProblems(input: { mode: CreditMode; reason: CreditReason | ''; text: string; amount: string; picked: number; creditedBefore: number; creditable: number | null }): { reason?: string; amount?: string; lines?: string; full?: string } {
  const problems: { reason?: string; amount?: string; lines?: string; full?: string } = {}
  if (input.reason === '') problems.reason = 'credit.problem.reason'
  else if (input.reason === 'OTHER' && input.text.trim().length < 3) problems.reason = 'credit.problem.text'
  if (input.mode === 'full' && input.creditedBefore > 0) problems.full = 'credit.problem.fullAfterPart'
  if (input.mode === 'lines' && input.picked === 0) problems.lines = 'credit.problem.lines'
  if (input.mode === 'amount') {
    const amount = parseAmount(input.amount)
    if (amount === null) problems.amount = 'credit.problem.amount'
    else if (input.creditable !== null && amount > input.creditable) problems.amount = 'credit.problem.over'
  }
  return problems
}

// ---- lines (a draft's edit, a rejected invoice's correction) ------------------------------------------------------------------

export interface LineDraft {
  id: string
  description: string
  quantity: string
  unitPrice: string
  discountPct: string
}

/** The goods and service lines as typed (deposit deductions are never edited here: the API keeps them). */
export function lineDraftsOf(lines: readonly InvoiceLine[], locale: Locale): LineDraft[] {
  return lines
    .filter((line) => line.kind !== 'DEPOSIT_DEDUCTION')
    .map((line) => ({ id: line.id, description: line.description, quantity: priceText(line.quantity, locale), unitPrice: line.unitPrice === undefined ? '' : priceText(line.unitPrice, locale), discountPct: line.discountPct ? priceText(line.discountPct, locale) : '' }))
}

/** Each typed line's problem (a message key), by line id. */
export function lineProblems(drafts: readonly LineDraft[]): Record<string, string> {
  const problems: Record<string, string> = {}
  for (const draft of drafts) {
    if (draft.description.trim() === '') problems[draft.id] = 'lines.problem.description'
    else if (draft.description.length > 1000) problems[draft.id] = 'lines.problem.long'
    else if (parseQuantity(draft.quantity) === null) problems[draft.id] = 'lines.problem.quantity'
    else if (parsePrice(draft.unitPrice) === null) problems[draft.id] = 'lines.problem.price'
    else if (draft.discountPct.trim() !== '') {
      const discount = Number(draft.discountPct.trim().replace(',', '.'))
      if (!Number.isFinite(discount) || discount <= 0 || discount >= 100) problems[draft.id] = 'lines.problem.discount'
    }
  }
  return problems
}

/** The lines as the API takes them back: every field of the stored line kept, the typed ones replaced. */
export function lineInputsOf(lines: readonly InvoiceLine[], drafts: readonly LineDraft[]) {
  return lines
    .filter((line) => line.kind !== 'DEPOSIT_DEDUCTION')
    .map((line) => {
      const draft = drafts.find((entry) => entry.id === line.id)
      return {
        kind: line.kind as 'GOODS' | 'SERVICE',
        description: (draft?.description ?? line.description).trim(),
        itemCode: line.itemCode,
        quantity: draft ? (parseQuantity(draft.quantity) ?? line.quantity) : line.quantity,
        uom: line.uom,
        unitPrice: draft ? (parsePrice(draft.unitPrice) ?? line.unitPrice ?? '0') : (line.unitPrice ?? '0'),
        discountPct: draft ? (draft.discountPct.trim() === '' ? null : draft.discountPct.trim().replace(',', '.')) : line.discountPct,
        vatRatePct: line.vatRatePct,
        vatNature: line.vatNature,
        vatLegalRef: line.vatLegalRef,
        salesOrderLineId: line.salesOrderLineId,
        size: line.size,
        ddtId: line.ddtId,
      }
    })
}

/** Whether the typed lines differ from the stored ones. */
export function linesChanged(lines: readonly InvoiceLine[], drafts: readonly LineDraft[], locale: Locale): boolean {
  const before = lineDraftsOf(lines, locale)
  return drafts.some((draft) => {
    const old = before.find((entry) => entry.id === draft.id)
    return !old || old.description !== draft.description || old.quantity !== draft.quantity || old.unitPrice !== draft.unitPrice || old.discountPct !== draft.discountPct
  })
}

// ---- payments --------------------------------------------------------------------------------------------------------------------

export type PlacedState = 'PLACED' | 'PARTLY' | 'NOT_PLACED' | 'VOIDED'

export const PLACED_TONE: Record<PlacedState, Tone> = { PLACED: 'success', PARTLY: 'info', NOT_PLACED: 'warning', VOIDED: 'neutral' }

/** Placed · Partly placed · Not placed · Voided; null without the price grain (the amounts decide it). */
export function placedStateOf(payment: Pick<PaymentRow, 'status' | 'allocated' | 'unallocated'>): PlacedState | null {
  if (payment.status === 'VOIDED') return 'VOIDED'
  if (payment.allocated === undefined || payment.unallocated === undefined) return null
  if (payment.unallocated <= 0) return 'PLACED'
  return payment.allocated > 0 ? 'PARTLY' : 'NOT_PLACED'
}

/** Problems of a typed payment (step 1 of "Record a payment"), as message keys. */
export function paymentProblems(input: { partyId: string | null; amount: string; receivedOn: string; reference: string; today: string }): { party?: string; amount?: string; receivedOn?: string; reference?: string } {
  const problems: { party?: string; amount?: string; receivedOn?: string; reference?: string } = {}
  if (!input.partyId) problems.party = 'recordPay.problem.party'
  if (parseAmount(input.amount) === null) problems.amount = 'recordPay.problem.amount'
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.receivedOn)) problems.receivedOn = 'recordPay.problem.date'
  else if (input.receivedOn > input.today) problems.receivedOn = 'recordPay.problem.future'
  const reference = input.reference.replace(/\s+/g, '').toUpperCase()
  if (reference === '') problems.reference = 'recordPay.problem.reference'
  else if (reference.length > 140) problems.reference = 'recordPay.problem.referenceLong'
  else if (!/^[A-Z0-9/._:-]+$/.test(reference)) problems.reference = 'recordPay.problem.referenceChars'
  return problems
}

/** "Suggest": the amount placed on the items oldest first, each up to what it asks (minor units by item id). */
export function suggestPlacement(items: readonly Pick<OpenItem, 'id' | 'openAmount'>[], amount: number): Record<string, number> {
  const plan: Record<string, number> = {}
  let left = amount
  for (const item of items) {
    if (left <= 0) break
    const open = item.openAmount ?? 0
    if (open <= 0) continue
    const take = Math.min(open, left)
    plan[item.id] = take
    left -= take
  }
  return plan
}

/** What is left to place of a payment after the typed placements (negative: more placed than received). */
export const leftToPlace = (amount: number, plan: Readonly<Record<string, number>>): number => amount - Object.values(plan).reduce((sum, value) => sum + value, 0)

/** The placement's problems (message keys by item id, and the whole). */
export function placementProblems(items: readonly Pick<OpenItem, 'id' | 'openAmount'>[], plan: Readonly<Record<string, number>>, amount: number): { items: Record<string, string>; total: string | null } {
  const problems: Record<string, string> = {}
  for (const [id, value] of Object.entries(plan)) {
    const item = items.find((entry) => entry.id === id)
    if (!item) continue
    if (value <= 0) problems[id] = 'match.problem.zero'
    else if (item.openAmount !== undefined && value > item.openAmount) problems[id] = 'match.problem.over'
  }
  return { items: problems, total: leftToPlace(amount, plan) < 0 ? 'match.problem.tooMuch' : null }
}

/** The allocations to send: the items with an amount, oldest first. */
export function allocationsOf(items: readonly Pick<OpenItem, 'id' | 'target'>[], plan: Readonly<Record<string, number>>): Array<{ depositRequestId?: string; invoiceId?: string; amount: number }> {
  return items.flatMap((item) => {
    const amount = plan[item.id]
    if (!amount || amount <= 0) return []
    return [item.target === 'INVOICE' ? { invoiceId: item.id, amount } : { depositRequestId: item.id, amount }]
  })
}

/** How an open item is called: the invoice number, else the deposit of its order. */
export function itemLabel(item: Pick<OpenItem, 'target' | 'number' | 'orderNumber'>): Phrase {
  if (item.target === 'INVOICE') return phrase('item.invoice', { number: item.number ?? '—' })
  return item.orderNumber ? phrase('item.deposit', { order: item.orderNumber }) : phrase('item.depositNoOrder')
}

/** The same for a placed allocation (the payment's chips). */
export function placedLabel(entry: { target: AllocationTarget; number: string | null; orderNumber: string | null }): Phrase {
  return itemLabel({ target: entry.target, number: entry.number, orderNumber: entry.orderNumber })
}

/** The allocations still standing (not reversed, not a reversal), for "take back". */
export const standing = (payment: Pick<Payment, 'allocations'>) => payment.allocations.filter((allocation) => !allocation.reversed && allocation.reversalOfId === null && (allocation.amount ?? 1) > 0)

// ---- CSV ------------------------------------------------------------------------------------------------------------------------

const cell = (value: string | number | null | undefined): string => {
  const text = value === null || value === undefined ? '' : String(value)
  return /[",;\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
}

/** The selected invoices as CSV: amounts only with the price grain (never more than the screen shows). */
export function invoicesCsv(rows: readonly InvoiceRow[], price: boolean, words: { header: (key: string) => string; docType: (docType: DocType) => string; status: (status: InvoiceStatus) => string }, locale: Locale): string {
  const columns = ['number', 'type', 'customer', 'date', 'status', ...(price ? ['net', 'vat', 'gross', 'paid', 'open'] : []), 'due']
  const lines = [columns.map((column) => cell(words.header(column))).join(',')]
  for (const row of rows) {
    lines.push(
      [
        row.number ?? '',
        `${words.docType(row.docType)} ${row.docType}`,
        row.partyName,
        row.issueDate,
        words.status(row.status),
        ...(price ? [money(row.netTotal, row.currency, locale), money(row.vatTotal, row.currency, locale), money(row.grossTotal, row.currency, locale), money(row.paidAmount, row.currency, locale), money(row.openAmount, row.currency, locale)] : []),
        row.dueDate,
      ]
        .map(cell)
        .join(','),
    )
  }
  return `${lines.join('\n')}\n`
}

/** The selected payments as CSV (amounts only with the price grain). */
export function paymentsCsv(rows: readonly PaymentRow[], price: boolean, words: { header: (key: string) => string; status: (status: PaymentRow['status']) => string; placed: (entry: PaymentRow['placedOn'][number]) => string }, locale: Locale): string {
  const columns = ['date', 'customer', 'reference', 'status', ...(price ? ['amount', 'placed', 'left'] : []), 'placedOn']
  const lines = [columns.map((column) => cell(words.header(column))).join(',')]
  for (const row of rows) {
    lines.push(
      [row.receivedOn, row.partyName, row.externalRef, words.status(row.status), ...(price ? [money(row.amount, row.currency, locale), money(row.allocated, row.currency, locale), money(row.unallocated, row.currency, locale)] : []), row.placedOn.map(words.placed).join(' · ')]
        .map(cell)
        .join(','),
    )
  }
  return `${lines.join('\n')}\n`
}

// ---- the API's errors in this app's words -------------------------------------------------------------------------------------------

export function readProblem(error: unknown): string {
  if (!isApiError(error)) return 'problem.read.internal'
  if (['signed_out', 'forbidden', 'not_found', 'unavailable', 'rate_limited'].includes(error.kind)) return `problem.read.${error.kind}`
  return 'problem.read.internal'
}

export interface WriteProblem extends Phrase {
  /** The record changed meanwhile: read it again. */
  reload: boolean
}

/** A refused write as words (never the API's English): a moved record, a state that does not allow it, a reference recorded… */
export function writeProblem(error: unknown): WriteProblem {
  if (!isApiError(error)) return { key: 'problem.write.internal', reload: false }
  const paths = error.issues.map(issuePath)
  if (error.kind === 'conflict') {
    if (paths.some((path) => path.split(/[./]/).includes('version'))) return { key: 'problem.write.moved', reload: true }
    if (paths.some((path) => path.includes('externalRef'))) return { key: 'problem.write.reference', reload: false }
    if (paths.some((path) => path.includes('ddtIds'))) return { key: 'problem.write.ddts', reload: true }
    if (paths.some((path) => path.includes('allocations'))) return { key: 'problem.write.allocation', reload: true }
    if (error.issues.some((issue) => typeof issue.code === 'string' && issue.code.startsWith('CREDIT_'))) return { key: 'problem.write.creditOver', reload: true }
    if (error.issues.some((issue) => typeof issue.code === 'string' && (CHECK_CODES as readonly string[]).includes(issue.code))) return { key: 'problem.write.checks', reload: true }
    return { key: 'problem.write.state', reload: true }
  }
  if (error.kind === 'invalid') {
    if (paths.some((path) => path.includes('externalRef'))) return { key: 'problem.write.reference', reload: false }
    if (paths.some((path) => path.includes('iban'))) return { key: 'problem.write.iban', reload: false }
    return { key: 'problem.write.invalid', reload: false }
  }
  if (['signed_out', 'forbidden', 'not_found', 'rate_limited', 'unavailable', 'step_up'].includes(error.kind)) return { key: `problem.write.${error.kind}`, reload: error.kind === 'not_found' }
  return { key: 'problem.write.internal', reload: false }
}

// ---- live -----------------------------------------------------------------------------------------------------------------------

/** Every id a live event's fields name (a string, or a list of strings). */
function idsOf(fields: Readonly<Record<string, unknown>>): string[] {
  return Object.values(fields).flatMap((value) => (typeof value === 'string' ? [value] : Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []))
}

/** An event that changes what the invoices page shows: an invoice moved, a payment placed, goods shipped or a DDT made. */
export const invoicesTouched = (change: { type: string }): boolean => change.type.startsWith('invoice.') || change.type.startsWith('payment.') || change.type.startsWith('shipment.') || change.type.startsWith('ddt.')

/** An event that changes what the payments page shows. */
export const paymentsTouched = (change: { type: string }): boolean => change.type.startsWith('payment.') || change.type === 'invoice.issued'

/** Whether a live event names a record the page shows (the invoice, its credit notes, its payments, its orders' deposits). */
export function recordTouched(change: { type: string; fields: Readonly<Record<string, unknown>> }, known: ReadonlySet<string>): boolean {
  if (!(change.type.startsWith('invoice.') || change.type.startsWith('payment.') || change.type.startsWith('order.') || change.type.startsWith('deposit_request.'))) return false
  return idsOf(change.fields).some((id) => known.has(id))
}
