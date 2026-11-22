import type { ChainInvoice, Order, SdiStatus, Settlement } from '../../api'
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
 *   Payment    words (price grain: they rest on the amounts): Open · Part paid · Paid · Credited · Refund due
 *   amounts    Total · This order · Open (price grain) — the deposit invoices' (TD02) and credit notes' (TD04) too (B-OM-003)
 *   doors      each opens FINANCE's own place (O2, one path): Record payment… (?new=1&invoice=), Credit note… (?do=credit; on a credit
 *              note held: "A credit note is corrected by a debit note."), Send to SDI / Fix and resend (the record's SDI & documents),
 *              Payments and write-off (the record's Money, payments.record), Documents and PDF (price grain) — each only with its right
 */

const GOODS = (docType: string) => docType !== 'TD02' && docType !== 'TD04'
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
  readonly invoice: ChainInvoice
  readonly kind: MoneyWord
  readonly state: { readonly word: MoneyWord; readonly tone: Tone }
  /** The SDI read of an issued invoice: still reading, or failed (its own Retry); null: read, or none to read. */
  readonly sdi: 'reading' | 'failed' | null
  /** Price grain only (null without it, or a draft). */
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
    const state = sdiValue ? { word: word(`sdi.state.${sdiValue.state.code}`), tone: SDI_TONE[sdiValue.state.code] } : { word: word(`invoiceStatus.${invoice.status}`), tone: INVOICE_TONE[invoice.status] ?? 'neutral' }
    const total = !price ? null : goods ? (amounts?.grossTotal ?? null) : (td02?.gross ?? td04?.gross ?? null)
    const share = !price ? null : goods ? (amounts?.share ?? amounts?.grossTotal ?? null) : total
    const open = !price || draft ? null : goods ? (amounts?.openAmount ?? null) : invoice.docType === 'TD02' && td02 ? 0 : null
    let payment: InvoiceRow['payment'] = null
    if (price && !draft) {
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
    if (td02 && (td02.deductedNet ?? 0) > 0) subs.push(word('moneyTab.invoices.sub.deducted'))
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

/** "3 documents · € 2,418.00 open on FT-2026-00012" (price) · "3 documents · all paid" · "3 documents" (words); nothing invoiced yet. */
function answerOf(rows: readonly InvoiceRow[], price: boolean): MoneyWord {
  if (rows.length === 0) return word('moneyTab.invoices.empty')
  const count = { count: rows.length }
  if (!price) return word('moneyTab.invoices.count', { params: count })
  const open = rows.find((row) => GOODS(row.invoice.docType) && (row.open ?? 0) > 0) ?? null
  if (open && open.invoice.number) return word('moneyTab.invoices.countOpen', { params: { ...count, number: open.invoice.number }, money: { amount: open.open ?? 0 } })
  const issued = rows.filter((row) => row.payment !== null)
  if (issued.length > 0 && issued.every((row) => row.payment!.word.key === 'moneyTab.invoices.pay.paid' || row.payment!.word.key === 'moneyTab.invoices.pay.credited')) return word('moneyTab.invoices.countPaid', { params: count })
  return word('moneyTab.invoices.count', { params: count })
}
