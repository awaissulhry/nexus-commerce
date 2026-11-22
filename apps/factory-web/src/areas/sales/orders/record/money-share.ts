import type { Settlement } from '../api'

/**
 * F-OP-118 (order page plan N3; 10-order-page §7; B-OP-022) — Money = this order's share, pure (no fetching, no React): per invoice
 * its whole beside this order's share, the other orders it bills (the invoice's own buyer only — the API's wall; named when the reader
 * reaches them, else counted) and its freight (in no order). No figure of the customer as a whole is ever drawn here: the customer's
 * statement is one link to the customer's page. F-OM-102: the totals and what is left to settle are money/totals.ts now (the server's
 * one still-to-pay rule; the gaps with their doors in place of the one "Settled when …" sentence).
 */

type SettlementInvoice = Settlement['invoices'][number]

/** An invoice that bills other orders too (named or counted). */
export const sharedInvoice = (invoice: Pick<SettlementInvoice, 'otherOrders' | 'otherOrdersHidden'>): boolean => (invoice.otherOrders?.length ?? 0) > 0 || (invoice.otherOrdersHidden ?? 0) > 0

/** "Also bills SO-0151, SO-0152" (+ "and N more you cannot open"): the other orders of the invoice's buyer; null: none. */
export function alsoBillsOf(invoice: Pick<SettlementInvoice, 'otherOrders' | 'otherOrdersHidden'>): { readonly orders: readonly { readonly id: string; readonly number: string }[]; readonly hidden: number } | null {
  if (!sharedInvoice(invoice)) return null
  return { orders: invoice.otherOrders ?? [], hidden: invoice.otherOrdersHidden ?? 0 }
}

/** "Freight € 40 is on the invoice, in no order" (price grain): the freight's amount when the invoice carries any; null: none. */
export const freightOf = (invoice: Pick<SettlementInvoice, 'freight'>): number | null => (invoice.freight !== undefined && invoice.freight > 0 ? invoice.freight : null)
