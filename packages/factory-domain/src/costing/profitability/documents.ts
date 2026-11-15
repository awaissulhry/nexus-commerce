/**
 * The order profitability report's documents (B-W2b-416; FIN-053 "order profitability report with documents"; design
 * finance.margins pop:order "Documents (W2b): invoices, credit notes, cost entries, freight, payments — each a link"), pure:
 * which invoice counts as what, how much of an invoice is this order's, what a payment paid of it, and the totals over the
 * documents in the order's own currency. Every amount is minor units of its document's currency; a document in another
 * currency is listed but never added (the totals say how many were left out). No person is named.
 */

/** An invoice of the order by its FatturaPA type (factory-db InvoiceDocType). */
export const INVOICE_KINDS = ['INVOICE', 'DEFERRED_INVOICE', 'DEPOSIT_INVOICE', 'DEBIT_NOTE', 'CREDIT_NOTE', 'OTHER'] as const
export type InvoiceKind = (typeof INVOICE_KINDS)[number]

const KIND_OF: Readonly<Record<string, InvoiceKind>> = Object.freeze({ TD01: 'INVOICE', TD24: 'DEFERRED_INVOICE', TD02: 'DEPOSIT_INVOICE', TD05: 'DEBIT_NOTE', TD04: 'CREDIT_NOTE' })

export const invoiceKindOf = (docType: string): InvoiceKind => KIND_OF[docType] ?? 'OTHER'

/**
 * What adds to "invoiced": an invoice, a deferred invoice and a debit note (the goods, services and charges billed). A
 * deposit invoice is listed but not added: the invoice of the goods bills them in full and takes the deposit off.
 */
export const ADDS_TO_INVOICED: readonly InvoiceKind[] = Object.freeze(['INVOICE', 'DEFERRED_INVOICE', 'DEBIT_NOTE'])

/**
 * An invoice counts once it is issued: a DRAFT is not a document yet, and SDI's REJECTED counts as never issued until it
 * is sent again (factory-db InvoiceStatus). Both are listed with their status, never added.
 */
export const counts = (status: string): boolean => status !== 'DRAFT' && status !== 'REJECTED'

/**
 * This order's part of an invoice: the net of its lines that name the order's lines (an invoice of several orders' DDTs
 * bills each its own lines); none naming them: the whole net when the invoice names the order itself (a deposit
 * invoice, an invoice made from the order), else nothing.
 */
export function forOrderOf(invoice: { readonly salesOrderId: string | null; readonly netTotal: number }, orderId: string, lines: readonly { readonly netAmount: number; readonly mine: boolean }[]): number {
  const mine = lines.filter((line) => line.mine)
  if (mine.length > 0) return mine.reduce((sum, line) => sum + line.netAmount, 0)
  return invoice.salesOrderId === orderId ? invoice.netTotal : 0
}

/** Whether an invoice also bills other orders (some of its lines name another order's lines). */
export const sharedInvoice = (lines: readonly { readonly mine: boolean; readonly ofAnOrder: boolean }[]): boolean => lines.some((line) => line.ofAnOrder && !line.mine)

/**
 * What a payment paid of this order: Σ its allocations to the order's invoices and deposit requests (a reversal is the
 * opposite amount, so a taken-back allocation adds nothing).
 */
export function paidOf(allocations: readonly { readonly amount: number }[]): number {
  return allocations.reduce((sum, allocation) => sum + allocation.amount, 0)
}

/** The kinds of cost document behind the order's cost. */
export const COST_KINDS = ['WORK_ORDER', 'COST_OF_SALES', 'SUBCONTRACT_ORDER', 'SUPPLIER_INVOICE'] as const

/** Why a figure of the report is partial (codes; the screen says them in words). */
export const DOCUMENT_NOTES = ['OTHER_CURRENCY', 'SHARED_INVOICE', 'SHARED_WORK_ORDER', 'FREIGHT_COST_MISSING', 'NOT_ISSUED'] as const
export type DocumentNote = (typeof DOCUMENT_NOTES)[number]

export interface TotalsInput {
  readonly currency: string
  readonly invoices: readonly { readonly kind: InvoiceKind; readonly status: string; readonly currency: string; readonly forOrder: number }[]
  readonly payments: readonly { readonly currency: string; readonly paid: number }[]
  readonly freight: readonly { readonly chargeCurrency: string; readonly charge: number | null; readonly costCurrency: string | null; readonly cost: number | null }[]
}

export interface Totals {
  /** Invoices, deferred invoices and debit notes issued, this order's part. */
  readonly invoiced: number
  /** Credit notes issued, this order's part (a positive amount, taken off). */
  readonly credited: number
  /** invoiced − credited. */
  readonly net: number
  /** Deposit invoices issued (listed, not added to invoiced). */
  readonly deposits: number
  /** Payments placed on the order's invoices and deposit requests. */
  readonly paid: number
  /** Freight charged to the customer, and what the carriers charged us (the cost grain). */
  readonly freightCharged: number
  readonly freightCost: number
  /** Documents in another currency, listed and not added. */
  readonly otherCurrency: number
}

/** The totals over the documents in the order's currency (the others counted in `otherCurrency`). */
export function totalsOf(input: TotalsInput): Totals {
  let invoiced = 0
  let credited = 0
  let deposits = 0
  let other = 0
  for (const invoice of input.invoices) {
    if (invoice.currency !== input.currency) {
      other += 1
      continue
    }
    if (!counts(invoice.status)) continue
    if (invoice.kind === 'CREDIT_NOTE') credited += invoice.forOrder
    else if (invoice.kind === 'DEPOSIT_INVOICE') deposits += invoice.forOrder
    else if (ADDS_TO_INVOICED.includes(invoice.kind)) invoiced += invoice.forOrder
  }
  let paid = 0
  for (const payment of input.payments) {
    if (payment.currency !== input.currency) other += 1
    else paid += payment.paid
  }
  let freightCharged = 0
  let freightCost = 0
  for (const row of input.freight) {
    if (row.charge !== null) {
      if (row.chargeCurrency === input.currency) freightCharged += row.charge
      else other += 1
    }
    if (row.cost !== null) {
      if (row.costCurrency === input.currency) freightCost += row.cost
      else other += 1
    }
  }
  return { invoiced, credited, net: invoiced - credited, deposits, paid, freightCharged, freightCost, otherCurrency: other }
}
