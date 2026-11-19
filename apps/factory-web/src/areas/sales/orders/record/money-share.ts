import type { Order, Settlement } from '../api'
import type { Phrase } from '../model'

/**
 * F-OP-118 (order page plan N3; 10-order-page §7; B-OP-022) — Money = this order's share, pure (no fetching, no React): the totals the
 * Money tab draws (Order total · Invoiced for this order · Paid on this order · Still to pay on this order · Deposits received), the
 * one "Settled when …" sentence, and per invoice its whole beside this order's share, the other orders it bills (the invoice's own
 * buyer only — the API's wall; named when the reader reaches them, else counted) and its freight (in no order). No figure of the
 * customer as a whole is ever drawn here: the customer's statement is one link to the customer's page.
 */

const phrase = (key: string, params?: Record<string, string | number>): Phrase => (params ? { key, params } : { key })

/** One total of the strip: its words key and its amount (minor units); null: not known here (never a made-up 0). */
export interface ShareTotal {
  readonly key: 'money.gross' | 'money.invoicedShare' | 'money.paidHere' | 'money.toPayHere' | 'money.depositPaid'
  readonly amount: number | null
}

/** The deposits received on the order's own requests (not the balance step before shipping). */
export const depositsReceivedOf = (order: Pick<Order, 'chain'>): number => order.chain.depositRequests.filter((entry) => entry.stepKind !== 'BEFORE_SHIPPING').reduce((sum, entry) => sum + (entry.paidAmount ?? 0), 0)

/**
 * The totals by this order's share. With the settlement (invoices.view): the API's `thisOrder` (an older answer: its invoice-wide
 * figures). Without it: the order total, the deposits received and still to pay as the order's gross less them — before the first
 * invoice too. The invoiced and paid-on-invoices figures need invoices.view: without it they are not drawn.
 */
export function shareTotalsOf(order: Pick<Order, 'grossAmount' | 'chain'>, settlement: Settlement | null, can: { readonly viewInvoices: boolean }): ShareTotal[] {
  const deposits = settlement?.thisOrder?.depositsPaid ?? depositsReceivedOf(order)
  const gross = order.grossAmount ?? null
  if (can.viewInvoices && settlement) {
    const mine = settlement.thisOrder
    return [
      { key: 'money.gross', amount: gross },
      { key: 'money.invoicedShare', amount: mine?.invoicedShare ?? settlement.invoicedAmount ?? null },
      { key: 'money.paidHere', amount: mine?.paid ?? settlement.paidAmount ?? null },
      { key: 'money.toPayHere', amount: mine?.stillToPay ?? settlement.balanceDueAmount ?? null },
      { key: 'money.depositPaid', amount: deposits },
    ]
  }
  return [
    { key: 'money.gross', amount: gross },
    { key: 'money.toPayHere', amount: gross === null ? null : Math.max(0, gross - deposits) },
    { key: 'money.depositPaid', amount: deposits },
  ]
}

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

/**
 * Settled stays invoice-wide and is said once: the order is settled when its open invoices are paid in full — "Settled when invoice
 * 12/2026 is paid in full (it also bills SO-0151)" for the first issued invoice still open; null when settled, or nothing is open.
 */
export function settledWhenOf(settlement: Pick<Settlement, 'settled' | 'invoices'> | null): Phrase | null {
  if (!settlement || settlement.settled) return null
  const open = settlement.invoices.find((invoice) => invoice.status !== 'DRAFT' && !!invoice.number && (invoice.openAmount ?? 0) > 0)
  if (!open) return null
  const others = (open.otherOrders ?? []).map((order) => order.number)
  if (others.length > 0) return phrase('money.settledWhenShared', { invoice: open.number!, numbers: others.join(', ') })
  return phrase('money.settledWhen', { invoice: open.number! })
}
