import { Dec, ZERO, type Decimal } from '../../tax/decimal'

/**
 * What "Invoiced" says of a sales order (B-TH-017; threads plan rule C8; features O-SAL-ORD-LIST.grid-F04): None, Part
 * or All, counted by pieces on ISSUED invoices less ISSUED credit notes, the one definition every screen and file uses
 * (the orders sheet, its export, and later Finance's "shipped, not invoiced" view: they share this function, not a route).
 *
 *   counted     an invoice line of an issued document (any status but DRAFT: a draft is the office's work, never
 *               "invoiced") that bills one of the order's lines: a GOODS line, or the SERVICE line that bills a FEE line
 *               (B-W2b-330). TD01 and TD24 add their pieces, a TD04 credit note takes its pieces away. A TD02 deposit
 *               invoice bills money in advance, not goods: it never makes an order "Part". Deposit deductions and
 *               accessory charges bill no order line.
 *   to invoice  each line's pieces less those closed short (B-W2a-30: they will never ship or be billed); a fee credited
 *               against the customer's bulk order (B-W2b-396) is settled there and owes nothing here.
 *   the state   NONE when nothing is invoiced (or credit notes took it all back); ALL when every line that still has
 *               pieces to invoice is invoiced in full (a line billed beyond its pieces never covers another line's gap);
 *               PART in between.
 *   the amount  the net of the counted lines (credit notes negative), minor units: shown only with the price grain.
 *
 * Pure: the API reads the rows (modules/sales/orders/row-extras.ts) and asks this.
 */

export const INVOICED_STATES = ['NONE', 'PART', 'ALL'] as const
export type InvoicedState = (typeof INVOICED_STATES)[number]

/** Document types that bill the goods (and fees): an immediate or a deferred invoice. */
export const BILLING_DOC_TYPES: readonly string[] = Object.freeze(['TD01', 'TD24'])
/** The credit note: what it credits of an order line is taken away. */
export const CREDIT_DOC_TYPE = 'TD04'

export interface InvoicedOrderLine {
  readonly id: string
  /** SIZE_GRID, MADE_TO_MEASURE or FEE (a fee is billed by a SERVICE line). */
  readonly kind: string
  readonly quantity: number
  /** Pieces closed short (null: the line is open). */
  readonly closedShortQuantity: number | null
  /** A fee credited against the customer's bulk order: settled there. */
  readonly feeCredited?: boolean
}

export interface InvoicedDocumentLine {
  /** The document's type and status (TD01, TD02, TD04, TD24; DRAFT, ISSUED, SENT, …). */
  readonly docType: string
  readonly status: string
  /** GOODS, SERVICE, DEPOSIT_DEDUCTION or CHARGE. */
  readonly kind: string
  readonly salesOrderLineId: string | null
  /** A decimal (FatturaPA quantities have 4 places). */
  readonly quantity: string
  /** Minor units, as on the line. */
  readonly netAmount: number
}

export interface Invoiced {
  readonly state: InvoicedState
  /** Pieces invoiced less credited, a decimal string. */
  readonly pieces: string
  /** Pieces the order still bills in all (its lines less those closed short). */
  readonly toInvoice: number
  /** The net invoiced less credited, minor units (price grain only). */
  readonly amount: number
}

/** +1 for a line an issued invoice bills, -1 for one an issued credit note credits, 0 for one that does not count. */
export function countedSign(line: Pick<InvoicedDocumentLine, 'docType' | 'status'>): 1 | -1 | 0 {
  if (line.status === 'DRAFT') return 0
  if (BILLING_DOC_TYPES.includes(line.docType)) return 1
  if (line.docType === CREDIT_DOC_TYPE) return -1
  return 0
}

/** The order's Invoiced state, pieces and amount from its lines and the invoice lines that name them. */
export function invoicedOf(lines: readonly InvoicedOrderLine[], documentLines: readonly InvoicedDocumentLine[]): Invoiced {
  const byId = new Map(lines.map((line) => [line.id, line]))
  const pieces = new Map<string, Decimal>()
  let total: Decimal = ZERO
  let amount = 0
  for (const row of documentLines) {
    const sign = countedSign(row)
    const line = row.salesOrderLineId === null ? undefined : byId.get(row.salesOrderLineId)
    if (sign === 0 || !line) continue
    const bills = row.kind === 'GOODS' || (row.kind === 'SERVICE' && line.kind === 'FEE')
    if (!bills) continue
    const quantity = new Dec(row.quantity).times(sign)
    pieces.set(line.id, (pieces.get(line.id) ?? ZERO).plus(quantity))
    total = total.plus(quantity)
    amount += sign * row.netAmount
  }
  const targets = lines.map((line) => ({ id: line.id, target: line.feeCredited ? 0 : Math.max(0, line.quantity - (line.closedShortQuantity ?? 0)) }))
  const toInvoice = targets.reduce((sum, line) => sum + line.target, 0)
  const all = targets.every((line) => line.target === 0 || (pieces.get(line.id) ?? ZERO).greaterThanOrEqualTo(line.target))
  const state: InvoicedState = total.lessThanOrEqualTo(0) ? 'NONE' : all ? 'ALL' : 'PART'
  return { state, pieces: total.toFixed(), toInvoice, amount }
}
