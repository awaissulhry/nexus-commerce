import type { InvoiceRow } from '../../../../finance/_shared/api'
import type { Tone } from '../../../orders/model'
import type { InvoiceListRow } from '../../../orders/record/money/view/parts'
import { word, type MoneyWord } from '../../../orders/record/money/word'
import { invoiceHref, orderMoneyHref, recordPaymentOnInvoiceHref } from './doors'
import { figuresOf } from './head'
import { isFailed, isReading, type MoneyTabInput, type Part, type ShippedNotInvoiced } from './model'
import { readProblem } from '../../../orders/model' // cm-fx2: the orders catalogue's own key of a failed read (its rule, never a literal here)

/**
 * F-CM-202 (customer page › MONEY tab, cm-w2 W2.2; 10-design §5.3; 18-lead-settles Z6, Z21, Z25) — section 3, Invoices & credit notes
 * (#invoices): every document of this customer (GET /invoicing/invoices?partyId&companyId — invoices.view; without it the section is
 * LEFT OUT), drawn with the shared `InvoiceList` part exactly as the order's Money draws it. Chips **All · Credit notes · Drafts** (the
 * read's own terms `docType=TD04`, `status=DRAFT`; it has no "open only" term). The first 5 rows, then "Show n more documents" (Z25), then
 * the read's cursor.
 *
 * A row says ORDER words (the part's own `useSay`, no prefix: Z15 — never a second word): the kind (`docType.*`), the state
 * (`invoiceStatus.*`; a rejected one "Rejected — fix and resend"), the Payment word only with the price grain (Z6: no word-code on the
 * list row this round — the column is left out for the others, never blank), by the order page's fallback rule on the row's own amounts:
 * a credit note is Credited · a deposit invoice Paid (Credited when credited in full) · a goods invoice Refund due when a credit note of
 * it has money to give back (the refunds read), else by the OPEN ITEMS (the list's own open amount ignores write-offs and refunds — so an
 * invoice not in the open items is never "Open" or "Part paid"; the section never sums the row's open amount). The sixth column is its
 * ORDER (the number when the server sends it — S8 — else "Order ›"), a door to that order's Invoices.
 * Each row's ⋯: the order page's five doors into Finance (Record payment… — euro only, Z21 · Credit note… — held on a credit note ·
 * Send to SDI › / Fix and resend › · Payments and write-off › · Documents and PDF ›), Show in the thread, Copy number.
 */

export const DOCUMENT_CHIPS = ['all', 'creditNotes', 'drafts'] as const
export type DocumentChip = (typeof DOCUMENT_CHIPS)[number]

/** Z25: the first five rows, then "Show n more documents". */
export const DOCUMENTS_SHOWN = 5
/** One page of the read (the API's cap is 200). */
export const DOCUMENTS_READ = 50

/** The read's own terms for a chip (one read per chip; All reads every document). */
export function documentQueryOf(chip: DocumentChip): { readonly docType: 'TD04' | null; readonly status: 'DRAFT' | null } {
  return { docType: chip === 'creditNotes' ? 'TD04' : null, status: chip === 'drafts' ? 'DRAFT' : null }
}

/** The read: the rows read so far (pages joined) and the cursor of the next page. */
export interface DocumentsRead {
  readonly rows: readonly InvoiceRow[]
  readonly next: string | null
}

export type DocumentDoorId = 'record' | 'credit' | 'sdi' | 'payments' | 'pdf'

export interface DocumentDoor {
  readonly id: DocumentDoorId
  /** The order page's own words, named with their catalogue (`orders:moneyTab.invoices.door.*`). */
  readonly label: MoneyWord
  readonly href: string | null
  /** Held by STATE, with words (a credit note is corrected by a debit note; not in euro). */
  readonly held: MoneyWord | null
}

export interface DocumentRow {
  /** The shared part's row, all but its sixth cell (the view hands the order's door there). */
  readonly list: Omit<InvoiceListRow, 'extra'>
  /** The order it bills: its number (S8) or none said, and the door to that order's Invoices. */
  readonly order: { readonly id: string; readonly number: string | null; readonly href: string } | null
  readonly doors: readonly DocumentDoor[]
}

export interface DocumentsModel {
  readonly reading: boolean
  readonly problem: string | null
  readonly rows: readonly DocumentRow[]
  /** "9 documents · 3 invoices open · 1 draft waits to be issued · 1 rejected by SDI". */
  readonly answer: readonly MoneyWord[]
  /** "Shipped, not invoiced: 1 shipment · € 1,952.00, invoice by 15/12/2026" (its own line, a door with invoices.manage). */
  readonly shipped: MoneyWord | null
  /** Finance's "Invoice shipped goods" window with this customer's DDTs chosen (invoices.manage; something shipped not invoiced). */
  readonly invoiceShipped: string | null
  /** The read has another page (its cursor). */
  readonly more: boolean
}

/** The state's tone — the order page's own map (rec/money/invoices.ts INVOICE_TONE; data, not a word). */
const INVOICE_TONE: Readonly<Record<string, Tone>> = { DRAFT: 'neutral', ISSUED: 'info', SENT: 'info', DELIVERED: 'success', NOT_DELIVERABLE: 'warning', REJECTED: 'danger', ERROR: 'danger' }
const GOODS = (docType: string): boolean => docType !== 'TD02' && docType !== 'TD04'

/** The Payment word (price grain only; null for a draft or a reader without prices: the column is then left out). */
export function paymentWordOf(row: InvoiceRow, input: MoneyTabInput): { readonly word: MoneyWord; readonly tone: Tone } | null {
  if (!input.can.price || row.status === 'DRAFT') return null
  if (row.docType === 'TD04') return { word: word('moneyTab.invoices.pay.credited'), tone: 'neutral' }
  if (row.docType === 'TD02') return (row.creditedAmount ?? 0) > 0 && (row.creditedAmount ?? 0) >= (row.grossTotal ?? Number.POSITIVE_INFINITY) ? { word: word('moneyTab.invoices.pay.credited'), tone: 'neutral' } : { word: word('moneyTab.invoices.pay.paid'), tone: 'success' }
  const refunds = input.refunds?.value ?? null
  const refundDue = !!refunds && [...refunds.refundsDue.map((refund) => refund.creditNote?.creditOfId ?? null), ...refunds.creditNotesToRefund.map((note) => note.creditOfId)].includes(row.id)
  if (refundDue) return { word: word('moneyTab.invoices.pay.refund'), tone: 'warning' }
  const items = input.openItems?.value?.items ?? null
  if (items) {
    const open = items.find((item) => item.target === 'INVOICE' && item.id === row.id)
    if (!open) return { word: word('moneyTab.invoices.pay.paid'), tone: 'success' }
    const left = open.openAmount ?? null
    const whole = open.amount ?? null
    return left !== null && whole !== null && left < whole ? { word: word('moneyTab.invoices.pay.part'), tone: 'warning' } : { word: word('moneyTab.invoices.pay.open'), tone: 'neutral' }
  }
  // No open items read (no payments.view): the list row's own amounts, the order page's fallback rule.
  const left = row.openAmount ?? null
  const paid = row.paidAmount ?? 0
  return left === 0 ? { word: word('moneyTab.invoices.pay.paid'), tone: 'success' } : left !== null && paid > 0 ? { word: word('moneyTab.invoices.pay.part'), tone: 'warning' } : left !== null ? { word: word('moneyTab.invoices.pay.open'), tone: 'neutral' } : null
}

/** A document's row (pure). `prefix`: `/w/<company>`. */
export function documentRowOf(row: InvoiceRow, all: readonly InvoiceRow[], input: MoneyTabInput, prefix: string): DocumentRow {
  const can = input.can
  const price = can.price
  const draft = row.status === 'DRAFT'
  const goods = GOODS(row.docType)
  const href = invoiceHref(prefix, { id: row.id, number: row.number }, row.companyId)
  const items = input.openItems?.value?.items ?? null
  const openItem = items ? (items.find((item) => item.target === 'INVOICE' && item.id === row.id) ?? null) : null
  // The open amount: the open items' (they count write-offs and refunds); an invoice not among them owes nothing; without them, the row's.
  const open = !price || draft || !goods ? null : items ? (openItem?.openAmount ?? 0) : (row.openAmount ?? null)
  const subs: MoneyWord[] = []
  if (row.dueDate && goods && !draft && (open === null || open > 0)) subs.push(word('moneyTab.plan.due.on', { days: { date: row.dueDate } }))
  const credited = row.creditOfId ? (all.find((other) => other.id === row.creditOfId)?.number ?? null) : null
  if (credited) subs.push(word('moneyTab.invoices.sub.credits', { params: { number: credited } }))
  const doors: DocumentDoor[] = []
  if (!draft && goods && can.paymentsRecord && (open === null || open > 0))
    doors.push(row.currency === 'EUR' ? { id: 'record', label: word('orders:moneyTab.invoices.door.record'), href: recordPaymentOnInvoiceHref(prefix, row.id), held: null } : { id: 'record', label: word('orders:moneyTab.invoices.door.record'), href: null, held: word('cm.collect.euroOnly', { params: { currency: row.currency } }) })
  if (!draft && can.invoicesManage) doors.push(row.docType === 'TD04' ? { id: 'credit', label: word('orders:moneyTab.invoices.door.credit'), href: null, held: word('orders:moneyTab.invoices.held.creditNote') } : { id: 'credit', label: word('orders:moneyTab.invoices.door.credit'), href: `${href}?do=credit`, held: null })
  if (can.invoicesIssue && ['ISSUED', 'REJECTED', 'ERROR', 'NOT_DELIVERABLE'].includes(row.status)) doors.push({ id: 'sdi', label: word(row.status === 'ISSUED' ? 'orders:moneyTab.invoices.door.sendSdi' : 'orders:moneyTab.invoices.door.fixSdi'), href: `${href}?tab=sdi`, held: null })
  if (!draft && goods && can.paymentsRecord) doors.push({ id: 'payments', label: word('orders:moneyTab.invoices.door.payments'), href: `${href}?tab=money`, held: null })
  if (!draft && price) doors.push({ id: 'pdf', label: word('orders:moneyTab.invoices.door.pdf'), href: `${href}?tab=sdi`, held: null })
  return {
    list: {
      id: row.id,
      anchor: `cm-Invoice-doc-${row.id}`,
      number: row.number,
      issueDate: row.issueDate,
      currency: row.currency,
      href,
      kind: word(`docType.${row.docType}`),
      state: row.status === 'REJECTED' ? { word: word('moneyTab.invoices.state.rejected'), tone: 'danger' } : { word: word(`invoiceStatus.${row.status}`), tone: INVOICE_TONE[row.status] ?? 'neutral' },
      sdi: null,
      payment: paymentWordOf(row, input),
      total: price && typeof row.grossTotal === 'number' ? row.grossTotal : null,
      open,
      subs,
      also: null,
    },
    order: row.salesOrderId ? { id: row.salesOrderId, number: row.orderNumber ?? null, href: orderMoneyHref(prefix, row.salesOrderId, 'invoices') } : null,
    doors,
  }
}

/** "Shipped, not invoiced: 1 shipment · € 1,952.00, invoice by 15/12/2026" (the value only with the price grain). */
function shippedWordsOf(shipped: ShippedNotInvoiced, price: boolean): MoneyWord {
  const count = word('cm.invoices.shipments', { params: { count: shipped.shipments } })
  const valued = price && shipped.value !== null ? word('cm.dot', { words: { first: count, second: word('cm.amount', { money: { amount: shipped.value } }) } }) : count
  const what = shipped.invoiceBy ? word('cm.answer.pair', { words: { first: valued, second: word('cm.invoices.invoiceBy', { days: { date: shipped.invoiceBy } }) } }) : valued
  return word('cm.invoices.shipped', { words: { what } })
}

/** The section's model (pure). Left out (null) without invoices.view. */
export function documentsOf(input: MoneyTabInput, read: Part<DocumentsRead> | null, chip: DocumentChip, prefix: string): DocumentsModel | null {
  if (!input.can.invoices || !read) return null
  const shippedRead = input.shipped?.value ?? null
  const shipped = shippedRead && shippedRead.shipments > 0 ? shippedWordsOf(shippedRead, input.can.price) : null
  // Finance's own From-DDTs window with the DDTs chosen (`ord/list/sheet/overall.ts` fromDdtsHref's address).
  const invoiceShipped = shippedRead && shippedRead.ddtIds.length > 0 && input.can.invoicesManage ? `${prefix}/finance/invoices?${new URLSearchParams({ new: '1', ddts: shippedRead.ddtIds.join(','), party: input.party.id }).toString()}` : null
  if (isReading(read)) return { reading: true, problem: null, rows: [], answer: [word('cm.invoices.reading')], shipped, invoiceShipped, more: false }
  const value = read.value
  if (isFailed(read) || !value) return { reading: false, problem: read.problem ?? readProblem(null), rows: [], answer: [], shipped, invoiceShipped, more: false }
  const rows = value.rows.map((row) => documentRowOf(row, value.rows, input, prefix))
  const more = value.next !== null
  const answer: MoneyWord[] = []
  if (rows.length > 0) answer.push(word(more ? 'cm.invoices.countMore' : 'cm.invoices.count', { params: { count: rows.length } }))
  // Open: the ageing's count of open invoices (the Balance figures' source), never a sum of the rows' open amounts (Z6).
  const open = chip === 'all' && input.can.price ? figuresOf(input).reduce((total, entry) => total + entry.openInvoices, 0) : 0
  if (open > 0) answer.push(word('finance-receivables:tiles.invoices', { params: { count: open } }))
  const drafts = value.rows.filter((row) => row.status === 'DRAFT').length
  if (drafts > 0 && chip !== 'drafts') answer.push(word('cm.invoices.drafts', { params: { count: drafts } }))
  const rejected = value.rows.filter((row) => row.status === 'REJECTED').length
  if (rejected > 0) answer.push(word('cm.invoices.rejected', { params: { count: rejected } }))
  return { reading: false, problem: null, rows, answer, shipped, invoiceShipped, more }
}
