import type { OpenItem, Related } from '../../_shared/api'
import type { Phrase } from '../../_shared/model'
import type { BalanceHold } from './api'

/**
 * The balance before shipping in words, pure (B-W2b-417; design finance.invoices rec:Invoice deposits/payments "Balance
 * before shipping (W2b): shipment held until paid"): per order of the invoice, the before-shipping step still open (what
 * is left to pay, by grain) and the shipments the system holds until it is paid, with who may let one go (`finance-invoices-depth`).
 */

const phrase = (key: string, params?: Record<string, string | number>): Phrase => (params ? { key, params } : { key })

export interface BalanceOrder {
  orderId: string
  number: string
  /** The open before-shipping steps of the order (minor units; absent without the price grain). */
  open: Array<{ id: string; openAmount?: number; currency?: string }>
  holds: BalanceHold[]
}

/** The invoice's orders with an open balance before shipping or a shipment held for it; empty: nothing to say. */
export function balanceOrdersOf(related: Pick<Related, 'orders'>, items: readonly OpenItem[], holds: readonly BalanceHold[]): BalanceOrder[] {
  return related.orders
    .map((order) => ({
      orderId: order.id,
      number: order.number,
      open: items.filter((item) => item.target === 'DEPOSIT_REQUEST' && item.stepKind === 'BEFORE_SHIPPING' && item.orderId === order.id).map((item) => ({ id: item.id, openAmount: item.openAmount, currency: item.currency })),
      holds: holds.filter((hold) => hold.shipment.salesOrderId === order.id),
    }))
    .filter((order) => order.open.length > 0 || order.holds.length > 0)
}

/** Why "Let it go" is held: the API's right for this hold, busy. */
export const releaseHeld = (hold: Pick<BalanceHold, 'mayRelease'>, busy: boolean): Phrase | null => (!hold.mayRelease ? phrase('balance.held.noRelease') : busy ? phrase('held.busy') : null)

/** The reason typed to let a shipment go: 3 to 2000 characters. */
export const releaseWordsProblem = (words: string): Phrase | null => (words.trim().length < 3 ? phrase('balance.releaseProblem.short') : words.trim().length > 2000 ? phrase('balance.releaseProblem.long') : null)

/** The refusal codes of a release this step words. */
export const HOLD_REFUSALS = ['NOT_IN_FORCE', 'MAY_NOT_RELEASE'] as const
