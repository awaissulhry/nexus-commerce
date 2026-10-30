import type { MinorUnits } from '../../core/money'
import { Dec, parseDecimal, ZERO, type Decimal } from '../../tax/decimal'
import { amountText, DOC_TYPE_WORDS, type InvoiceDocType } from '../invoices'

/**
 * Is the order settled: every line shipped, invoiced and paid? (B-W1-51; PLAN §4.7 "Closing the order": the port the
 * close command of B-W1-25 asks; stage 15-invoice), pure.
 *
 * Settled means all of:
 *   shipped      every size of every line shipped (lines on SHIPPED or DELIVERED shipments) as ordered, a line closed
 *                short counting as shipped for what it never shipped (B-W2a-54);
 *   invoiced     every garment shipped billed by an issued TD01 or TD24 (none less, none more);
 *   documents    every fiscal document of the order (its TD01/TD24 invoices, the TD02s of its deposit requests, the
 *                TD04s that credit them) reached the customer's side at SDI: DELIVERED or NOT_DELIVERABLE (the latter
 *                is a valid invoice in the customer's tax drawer; B-W1-50) — never on ISSUED alone;
 *   deposits     every issued TD02 deducted in full on the order's invoices (less its credit notes), and no deposit
 *                paid without its deposit invoice when its request asks for one;
 *   money        the balance (the invoices' gross less their credit notes less what is paid on them, less the deposits
 *                paid on requests that issue no TD02) is 0, and no refund is due (a credit note on a paid invoice
 *                leaves a refund due; refunds are W2b).
 * A CANCELLED order is never settled. Each missing piece is said in words (`missing`), with a code.
 */

export interface SettlementLine {
  readonly salesOrderLineId: string
  readonly seq: number
  readonly description: string
  /** Its sizes as ordered (a line without size rows: one entry, size null, the line's quantity). */
  readonly sizes: readonly { readonly size: string | null; readonly ordered: number }[]
  /**
   * B-W2a-54: the line was closed short (B-W2a-30 SalesOrderLine.closedShortQuantity): each size's pieces not shipped are
   * done, not owed (toShip 0), so a closed-short order settles on what shipped.
   */
  readonly closedShort?: boolean
}

export interface SettlementInvoice {
  readonly id: string
  readonly docType: InvoiceDocType
  readonly number: string | null
  readonly status: string
  readonly grossTotal: MinorUnits
  /** TD01/TD24: the gross of its issued credit notes, and what payments pay on it. */
  readonly creditedGross: MinorUnits
  readonly paid: MinorUnits
}

export interface SettlementDepositInvoice {
  readonly id: string
  readonly depositRequestId: string
  readonly number: string | null
  readonly status: string
  readonly netTotal: MinorUnits
  readonly grossTotal: MinorUnits
  readonly creditedNet: MinorUnits
  readonly creditedGross: MinorUnits
  /** What issued invoices deduct from it (net, positive). */
  readonly deductedNet: MinorUnits
}

export interface SettlementFacts {
  readonly order: { readonly id: string; readonly number: string; readonly status: string; readonly currency: string }
  readonly lines: readonly SettlementLine[]
  /** Garments on SHIPPED or DELIVERED shipments, per order line and size. */
  readonly shipped: readonly { readonly salesOrderLineId: string; readonly size: string; readonly quantity: number }[]
  /** The GOODS lines of issued TD01/TD24 per order line and size (Decimal(18,4) strings). */
  readonly invoiced: readonly { readonly salesOrderLineId: string; readonly size: string | null; readonly quantity: string }[]
  /** The issued TD01/TD24 that bill the order (a line of it, or the order named). */
  readonly invoices: readonly SettlementInvoice[]
  readonly depositRequests: readonly { readonly id: string; readonly status: string; readonly fiscalDocument: 'TD02' | 'NONE'; readonly amount: MinorUnits; readonly paid: MinorUnits }[]
  readonly depositInvoices: readonly SettlementDepositInvoice[]
  /** The issued TD04s of those invoices and deposit invoices. */
  readonly creditNotes: readonly { readonly id: string; readonly number: string | null; readonly status: string; readonly creditOfId: string }[]
}

export type SettlementGap = 'ORDER_CANCELLED' | 'NOT_SHIPPED' | 'NOT_INVOICED' | 'OVER_INVOICED' | 'NO_INVOICE' | 'AT_SDI' | 'DEPOSIT_NOT_DEDUCTED' | 'DEPOSIT_NOT_INVOICED' | 'BALANCE_DUE' | 'REFUND_DUE'

export interface SettlementLineView {
  readonly salesOrderLineId: string
  readonly seq: number
  readonly description: string
  readonly size: string | null
  readonly ordered: number
  readonly shipped: number
  /** Decimal string. */
  readonly invoiced: string
  readonly toShip: number
  /** Pieces closed short (ordered, never shipped, no longer owed); 0 on an open line. */
  readonly closedShort: number
  readonly toInvoice: string
}

export interface OrderSettlement {
  readonly orderId: string
  readonly settled: boolean
  readonly missing: readonly { readonly code: SettlementGap; readonly message: string }[]
  readonly fullyShipped: boolean
  readonly fullyInvoiced: boolean
  readonly documentsFinal: boolean
  readonly lines: readonly SettlementLineView[]
  readonly invoices: readonly (SettlementInvoice & { readonly open: MinorUnits; readonly refundDue: MinorUnits })[]
  readonly money: {
    /** The issued TD01/TD24 totals (after the deposits they deduct). */
    readonly invoicedGross: MinorUnits
    readonly creditedGross: MinorUnits
    readonly paidOnInvoices: MinorUnits
    /** Paid on deposit requests that issue no TD02: it pays the order's invoices. */
    readonly depositsPaidWithoutInvoice: MinorUnits
    readonly balanceDue: MinorUnits
    readonly refundDue: MinorUnits
  }
}

const FINAL = new Set(['DELIVERED', 'NOT_DELIVERABLE'])
const sizeKey = (lineId: string, size: string | null): string => `${lineId}|${size ?? ''}`

export function orderSettlement(facts: SettlementFacts): OrderSettlement {
  const currency = facts.order.currency
  const missing: { code: SettlementGap; message: string }[] = []
  const add = (code: SettlementGap, message: string) => missing.push({ code, message })
  if (facts.order.status === 'CANCELLED') add('ORDER_CANCELLED', `Order ${facts.order.number} is cancelled.`)

  // Shipped and invoiced, per line and size.
  const shipped = new Map<string, number>()
  const shippedByLine = new Map<string, number>()
  for (const row of facts.shipped) {
    shipped.set(sizeKey(row.salesOrderLineId, row.size), (shipped.get(sizeKey(row.salesOrderLineId, row.size)) ?? 0) + row.quantity)
    shippedByLine.set(row.salesOrderLineId, (shippedByLine.get(row.salesOrderLineId) ?? 0) + row.quantity)
  }
  const invoiced = new Map<string, Decimal>()
  const invoicedByLine = new Map<string, Decimal>()
  for (const row of facts.invoiced) {
    const quantity = parseDecimal(row.quantity) ?? ZERO
    invoiced.set(sizeKey(row.salesOrderLineId, row.size), (invoiced.get(sizeKey(row.salesOrderLineId, row.size)) ?? ZERO).plus(quantity))
    invoicedByLine.set(row.salesOrderLineId, (invoicedByLine.get(row.salesOrderLineId) ?? ZERO).plus(quantity))
  }
  const lines: SettlementLineView[] = []
  for (const line of [...facts.lines].sort((a, b) => a.seq - b.seq)) {
    for (const entry of line.sizes) {
      // A line without size rows counts every size it shipped and invoiced.
      const shippedQty = entry.size === null ? (shippedByLine.get(line.salesOrderLineId) ?? 0) : (shipped.get(sizeKey(line.salesOrderLineId, entry.size)) ?? 0)
      const invoicedQty = entry.size === null ? (invoicedByLine.get(line.salesOrderLineId) ?? ZERO) : (invoiced.get(sizeKey(line.salesOrderLineId, entry.size)) ?? ZERO)
      const toInvoice = new Dec(shippedQty).minus(invoicedQty)
      const notShipped = Math.max(0, entry.ordered - shippedQty)
      lines.push({
        salesOrderLineId: line.salesOrderLineId,
        seq: line.seq,
        description: line.description,
        size: entry.size,
        ordered: entry.ordered,
        shipped: shippedQty,
        invoiced: invoicedQty.toString(),
        toShip: line.closedShort ? 0 : notShipped,
        closedShort: line.closedShort ? notShipped : 0,
        toInvoice: (toInvoice.isNegative() ? ZERO : toInvoice).toString(),
      })
    }
  }
  const label = (line: SettlementLineView) => `line ${line.seq}${line.size ? ` size ${line.size}` : ''}`
  const unshipped = lines.filter((line) => line.toShip > 0)
  const fullyShipped = unshipped.length === 0 && lines.length > 0
  if (lines.length === 0) add('NOT_SHIPPED', `Order ${facts.order.number} has no line.`)
  if (unshipped.length > 0) add('NOT_SHIPPED', `Not shipped yet: ${unshipped.map((line) => `${line.toShip} of ${label(line)}`).join(', ')}.`)
  const uninvoiced = lines.filter((line) => new Dec(line.toInvoice).gt(0))
  const over = lines.filter((line) => new Dec(line.invoiced).gt(line.shipped))
  if (uninvoiced.length > 0) add('NOT_INVOICED', `Shipped, not invoiced: ${uninvoiced.map((line) => `${line.toInvoice} of ${label(line)}`).join(', ')}.`)
  if (over.length > 0) add('OVER_INVOICED', `Invoiced beyond what shipped: ${over.map((line) => label(line)).join(', ')}: a credit note corrects it.`)
  const fullyInvoiced = uninvoiced.length === 0 && over.length === 0
  if (facts.invoices.length === 0) add('NO_INVOICE', `Order ${facts.order.number} has no issued invoice.`)

  // Every fiscal document at the customer's side.
  const documents = [
    ...facts.invoices.map((invoice) => ({ docType: invoice.docType, number: invoice.number, status: invoice.status })),
    ...facts.depositInvoices.map((invoice) => ({ docType: 'TD02' as const, number: invoice.number, status: invoice.status })),
    ...facts.creditNotes.map((note) => ({ docType: 'TD04' as const, number: note.number, status: note.status })),
  ]
  const pending = documents.filter((document) => !FINAL.has(document.status))
  const documentsFinal = pending.length === 0
  if (pending.length > 0) {
    add('AT_SDI', `Not delivered by SDI yet: ${pending.map((document) => `${DOC_TYPE_WORDS[document.docType].toLowerCase()} ${document.number ?? '(draft)'} (${document.status})`).join(', ')}.`)
  }

  // Deposits.
  for (const deposit of facts.depositInvoices) {
    const left = deposit.netTotal - deposit.creditedNet - deposit.deductedNet
    if (left > 0 && deposit.status !== 'REJECTED') add('DEPOSIT_NOT_DEDUCTED', `Deposit invoice ${deposit.number} is not deducted in full: ${amountText(left, currency)} of its net is left. Deduct it on the order's invoice, or credit it.`)
  }
  let depositsPaidWithoutInvoice = 0
  let refundDue = 0
  for (const request of facts.depositRequests) {
    if (request.fiscalDocument === 'NONE') {
      depositsPaidWithoutInvoice += Math.max(0, request.paid)
      continue
    }
    const issued = facts.depositInvoices.filter((invoice) => invoice.depositRequestId === request.id && invoice.status !== 'REJECTED')
    const invoicedGross = issued.reduce((sum, invoice) => sum + invoice.grossTotal - invoice.creditedGross, 0)
    const credited = issued.reduce((sum, invoice) => sum + invoice.creditedGross, 0)
    const excess = request.paid - invoicedGross
    if (excess > 0 && credited > 0) refundDue += Math.min(excess, credited)
    else if (excess > 0) add('DEPOSIT_NOT_INVOICED', `${amountText(excess, currency)} paid on a deposit request has no deposit invoice yet (DPR 633/1972 art. 6 c.4).`)
  }

  // The balance.
  const invoices = facts.invoices.map((invoice) => {
    const open = invoice.grossTotal - invoice.creditedGross - invoice.paid
    return { ...invoice, open: Math.max(0, open), refundDue: Math.max(0, -open) }
  })
  const openSum = invoices.reduce((sum, invoice) => sum + invoice.open, 0)
  refundDue += invoices.reduce((sum, invoice) => sum + invoice.refundDue, 0)
  const balanceDue = Math.max(0, openSum - depositsPaidWithoutInvoice)
  if (balanceDue > 0) add('BALANCE_DUE', `${amountText(balanceDue, currency)} is still to be paid on the order's invoices.`)
  if (refundDue > 0) add('REFUND_DUE', `A refund of ${amountText(refundDue, currency)} is due to the customer (a credit note on what was paid; refunds are W2b).`)

  return {
    orderId: facts.order.id,
    settled: missing.length === 0,
    missing,
    fullyShipped,
    fullyInvoiced,
    documentsFinal,
    lines,
    invoices,
    money: {
      invoicedGross: facts.invoices.reduce((sum, invoice) => sum + invoice.grossTotal, 0),
      creditedGross: facts.invoices.reduce((sum, invoice) => sum + invoice.creditedGross, 0),
      paidOnInvoices: facts.invoices.reduce((sum, invoice) => sum + invoice.paid, 0),
      depositsPaidWithoutInvoice,
      balanceDue,
      refundDue,
    },
  }
}
