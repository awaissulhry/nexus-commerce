import type { ChainInvoice, InvoicePaymentState, Order, SdiStatus, Settlement } from '../../api'
import { SDI_TONE, type OrderAbilities, type Tone } from '../../model'
import type { Part } from '../record-model'
import { alsoBillsOf, freightOf } from '../money-share'
import { word, type MoneyWord } from './word'

/**
 * F-OM-203 (order MONEY tab, 10-design §6; M5-B1 … B9; 18-lead-settles §"Other corrections") — section 3, Invoices & credit notes
 * (#invoices; invoices.view): every bill of this order, where it stands and what is still to pay. Pure.
 *
 *   State      ONE column: the invoice's own life (DRAFT → ISSUED → SENT → DELIVERED / NOT_DELIVERABLE / REJECTED / ERROR — the SDI
 *              state inside it, B-OM-003), the SDI read's own words where it was read; a failed SDI read: "Couldn't read · Retry"
 *   Payment    words: Open · Part paid · Paid · Credited · Refund due — the settlement's own word-code (B-OM-023, every invoices.view
 *              reader: Sales reads the words, never an amount); without it (a deposit invoice, a credit note) from the amounts (price)
 *   amounts    Total · This order · Open (price grain) — the deposit invoices' (TD02) and credit notes' (TD04) too (B-OM-003)
 *   doors      each opens FINANCE's own place (O2, one path): Record payment… (?new=1&invoice=), Credit note… (?do=credit; on a credit
 *              note held: "A credit note is corrected by a debit note."), Send to SDI / Fix and resend (the record's SDI & documents),
 *              Payments and write-off (the record's Money, payments.record), Documents and PDF (price grain) — each only with its right
 */

const GOODS = (docType: string) => docType !== 'TD02' && docType !== 'TD04'
/** F-OM-203 (B-OM-023): the settlement's payment word-code, in this page's words and tone. */
const PAYMENT_WORD: Readonly<Record<InvoicePaymentState, { readonly key: string; readonly tone: Tone }>> = {
  OPEN: { key: 'moneyTab.invoices.pay.open', tone: 'neutral' },
  PART_PAID: { key: 'moneyTab.invoices.pay.part', tone: 'warning' },
  PAID: { key: 'moneyTab.invoices.pay.paid', tone: 'success' },
  CREDITED: { key: 'moneyTab.invoices.pay.credited', tone: 'neutral' },
  REFUND_DUE: { key: 'moneyTab.invoices.pay.refund', tone: 'warning' },
}
const INVOICE_TONE: Readonly<Record<string, Tone>> = { DRAFT: 'neutral', ISSUED: 'info', SENT: 'info', DELIVERED: 'success', NOT_DELIVERABLE: 'warning', REJECTED: 'danger', ERROR: 'danger' }

export type InvoiceDoorId = 'record' | 'credit' | 'sdi' | 'payments' | 'pdf'

export interface InvoiceDoor {
  readonly id: InvoiceDoorId
  readonly label: MoneyWord
  /** Finance's own place; null: held (its words in `held`). */
  readonly href: string | null
  readonly held: MoneyWord | null
}

export interface InvoiceRow {
  readonly id: string
  readonly anchor: string
  // F-CM-k1: the plain fields the shared list draws (view/parts.tsx InvoiceListRow) — the number (null: a draft), the day of issue,
  // the currency its amounts and words are said in (the order's), the document's own page (Finance). `invoice` stays: the row's ⋯.
  readonly number: string | null
  readonly issueDate: string | null
  readonly currency: string
  readonly href: string
  readonly invoice: ChainInvoice
  readonly kind: MoneyWord
  readonly state: { readonly word: MoneyWord; readonly tone: Tone }
  /** The SDI read of an issued invoice: still reading, or failed (its own Retry); null: read, or none to read. */
  readonly sdi: 'reading' | 'failed' | null
  /** The settlement's word-code (every reader, B-OM-023), else from the amounts (price grain); null: a draft, or not known. */
  readonly payment: { readonly word: MoneyWord; readonly tone: Tone } | null
  readonly total: number | null
  readonly share: number | null
  readonly open: number | null
  readonly subs: readonly MoneyWord[]
  readonly also: ReturnType<typeof alsoBillsOf>
  readonly doors: readonly InvoiceDoor[]
}

export interface InvoicesModel {
  readonly rows: readonly InvoiceRow[]
  readonly answer: MoneyWord
}

export function invoicesOf(input: { readonly order: Order; readonly settlement: Settlement | null; readonly sdi: Record<string, Part<SdiStatus>> | null; readonly can: OrderAbilities; readonly invoiceHref: (invoice: ChainInvoice) => string; readonly prefix: string }): InvoicesModel {
  const { order, settlement, sdi, can, invoiceHref, prefix } = input
  const price = can.price
  const final = order.status === 'CLOSED' || order.status === 'CANCELLED'
  const numberOf = (id: string | null) => (id ? (order.chain.invoices.find((entry) => entry.id === id)?.number ?? null) : null)
  const rows: InvoiceRow[] = order.chain.invoices.map((invoice) => {
    const draft = invoice.status === 'DRAFT'
    const goods = GOODS(invoice.docType)
    const amounts = goods ? (settlement?.invoices.find((entry) => entry.id === invoice.id) ?? null) : null
    const td02 = invoice.docType === 'TD02' ? (settlement?.depositInvoices?.find((entry) => entry.id === invoice.id) ?? null) : null
    const td04 = invoice.docType === 'TD04' ? (settlement?.creditNotes?.find((entry) => entry.id === invoice.id) ?? null) : null
    const read = !draft ? (sdi?.[invoice.id] ?? null) : null
    const sdiValue = read?.value ?? null
    // F-OM-fx3 (W-13): a rejected invoice says what to do: "Rejected — fix and resend".
    const rejected = sdiValue ? sdiValue.state.code === 'REJECTED' : invoice.status === 'REJECTED'
    const state = rejected
      ? { word: word('moneyTab.invoices.state.rejected'), tone: 'danger' as const }
      : sdiValue
        ? { word: word(`sdi.state.${sdiValue.state.code}`), tone: SDI_TONE[sdiValue.state.code] }
        : { word: word(`invoiceStatus.${invoice.status}`), tone: INVOICE_TONE[invoice.status] ?? 'neutral' }
    const total = !price ? null : goods ? (amounts?.grossTotal ?? null) : (td02?.gross ?? td04?.gross ?? null)
    const share = !price ? null : goods ? (amounts?.share ?? amounts?.grossTotal ?? null) : total
    // F-OM-fx3 (W-13): a deposit invoice has no Open of its own (it is paid by the money it was issued for): no cell, never "€ 0.00".
    const open = !price || draft || !goods ? null : (amounts?.openAmount ?? null)
    let payment: InvoiceRow['payment'] = null
    // F-OM-fx3 (B-OM-026, W-12): a deposit invoice's and a credit note's word-code too — every invoices.view reader, no amount.
    const coded = !draft ? (amounts?.paymentState ?? td02?.paymentState ?? td04?.paymentState ?? null) : null
    if (coded) payment = { word: word(PAYMENT_WORD[coded].key), tone: PAYMENT_WORD[coded].tone }
    else if (price && !draft) {
      if (invoice.docType === 'TD04') payment = { word: word('moneyTab.invoices.pay.credited'), tone: 'neutral' }
      else if (invoice.docType === 'TD02') payment = td02 && (td02.credited ?? 0) >= (td02.gross ?? Number.POSITIVE_INFINITY) ? { word: word('moneyTab.invoices.pay.credited'), tone: 'neutral' } : { word: word('moneyTab.invoices.pay.paid'), tone: 'success' }
      else if (amounts) {
        const paid = amounts.paidAmount ?? 0
        const left = amounts.openAmount ?? null
        payment = (amounts.refundDueAmount ?? 0) > 0
          ? { word: word('moneyTab.invoices.pay.refund'), tone: 'warning' }
          : left === 0
            ? { word: word('moneyTab.invoices.pay.paid'), tone: 'success' }
            : left !== null && paid > 0
              ? { word: word('moneyTab.invoices.pay.part'), tone: 'warning' }
              : left !== null
                ? { word: word('moneyTab.invoices.pay.open'), tone: 'neutral' }
                : null
      }
    }
    const subs: MoneyWord[] = []
    const credits = td04?.creditOfId ? numberOf(td04.creditOfId) : null
    if (credits) subs.push(word('moneyTab.invoices.sub.credits', { params: { number: credits } }))
    // F-OM-fx3 (B-OM-028, W-13): what a goods invoice deducts and bills; where a TD02 was deducted and the payment it was issued for.
    for (const deducted of amounts?.deducts ?? []) {
      if (deducted.number) subs.push(price && typeof deducted.amount === 'number' ? word('moneyTab.invoices.sub.deducts', { params: { number: deducted.number }, money: { amount: deducted.amount } }) : word('moneyTab.invoices.sub.deductsWords', { params: { number: deducted.number } }))
    }
    const shipments = amounts?.forShipments ?? []
    if (shipments.length > 0) subs.push(word(shipments.length === 1 ? 'moneyTab.invoices.sub.forShipment' : 'moneyTab.invoices.sub.forShipments', { params: { numbers: shipments.map((shipment) => shipment.number).join(', ') } }))
    if (td02?.deductedOn?.number) subs.push(word('moneyTab.invoices.sub.deductedOn', { params: { number: td02.deductedOn.number } }))
    else if (td02 && (td02.deductedNet ?? 0) > 0) subs.push(word('moneyTab.invoices.sub.deducted'))
    if (td02?.forPayment) subs.push(word('moneyTab.invoices.sub.forPayment', { days: { date: td02.forPayment.receivedOn } }))
    const freight = amounts && price ? freightOf(amounts) : null
    if (freight !== null) subs.push(word('money.freight', { money: { amount: freight } }))
    // ---- the doors into Finance: each only with its right; held only by the invoice's state ----
    const doors: InvoiceDoor[] = []
    const href = invoiceHref(invoice)
    if (!draft && goods && !final && can.recordPayment && (open === null || open > 0)) doors.push({ id: 'record', label: word('moneyTab.invoices.door.record'), href: `${prefix}/finance/payments?new=1&invoice=${encodeURIComponent(invoice.id)}`, held: null })
    if (!draft && can.manageInvoices) doors.push(invoice.docType === 'TD04' ? { id: 'credit', label: word('moneyTab.invoices.door.credit'), href: null, held: word('moneyTab.invoices.held.creditNote') } : { id: 'credit', label: word('moneyTab.invoices.door.credit'), href: `${href}?do=credit`, held: null })
    if (can.issueInvoices && (invoice.status === 'ISSUED' || invoice.status === 'REJECTED' || invoice.status === 'ERROR' || invoice.status === 'NOT_DELIVERABLE')) doors.push({ id: 'sdi', label: word(invoice.status === 'ISSUED' ? 'moneyTab.invoices.door.sendSdi' : 'moneyTab.invoices.door.fixSdi'), href: `${href}?tab=sdi`, held: null })
    // Payments and write-off ›: Finance's acting place (payments.record), never a reader's door (10-design §10: Sales —).
    if (!draft && goods && can.recordPayment) doors.push({ id: 'payments', label: word('moneyTab.invoices.door.payments'), href: `${href}?tab=money`, held: null })
    if (!draft && price) doors.push({ id: 'pdf', label: word('moneyTab.invoices.door.pdf'), href: `${href}?tab=sdi`, held: null })
    return {
      id: invoice.id,
      anchor: `about-Invoice-${invoice.id}`,
      number: invoice.number, // F-CM-k1: the plain fields (above)
      issueDate: invoice.issueDate,
      currency: order.currency,
      href,
      invoice,
      kind: word(`docType.${invoice.docType}`),
      state,
      sdi: read && !read.value ? (read.problem ? 'failed' : 'reading') : null,
      payment,
      total,
      share,
      open,
      subs,
      also: amounts ? alsoBillsOf(amounts) : null,
      doors,
    }
  })
  return { rows, answer: answerOf(rows, price) }
}

/**
 * "3 documents · € 2,418.00 open on FT-2026-00012" (price) · "3 documents · FT-2026-00012 is part paid" (words, F-OM-fx5w N9) ·
 * "3 documents · all paid" · "3 documents"; nothing invoiced yet.
 */
function answerOf(rows: readonly InvoiceRow[], price: boolean): MoneyWord {
  if (rows.length === 0) return word('moneyTab.invoices.empty')
  const count = { count: rows.length }
  const open = price ? (rows.find((row) => GOODS(row.invoice.docType) && (row.open ?? 0) > 0) ?? null) : null
  if (open && open.invoice.number) return word('moneyTab.invoices.countOpen', { params: { ...count, number: open.invoice.number }, money: { amount: open.open ?? 0 } })
  // F-OM-fx5w (N9, 10-design §6): without the price grain, the first goods invoice still open named by its Payment word (the settlement's
  // word-code, B-OM-023) — never only "1 document". A rejected one counts for nothing.
  const said = (row: InvoiceRow) => row.payment?.word.key ?? null
  const named = !price ? (rows.find((row) => GOODS(row.invoice.docType) && !!row.invoice.number && row.state.word.key !== 'moneyTab.invoices.state.rejected' && (said(row) === PAYMENT_WORD.PART_PAID.key || said(row) === PAYMENT_WORD.OPEN.key)) ?? null) : null
  if (named) return word(said(named) === PAYMENT_WORD.PART_PAID.key ? 'moneyTab.invoices.countPart' : 'moneyTab.invoices.countUnpaid', { params: { ...count, number: named.invoice.number! } })
  // F-OM-203 (B-OM-023): "all paid" is said to a reader without the price grain too (the settlement's word-codes).
  const issued = rows.filter((row) => row.payment !== null)
  if (issued.length > 0 && issued.every((row) => row.payment!.word.key === 'moneyTab.invoices.pay.paid' || row.payment!.word.key === 'moneyTab.invoices.pay.credited')) return word('moneyTab.invoices.countPaid', { params: count })
  return word('moneyTab.invoices.count', { params: count })
}
