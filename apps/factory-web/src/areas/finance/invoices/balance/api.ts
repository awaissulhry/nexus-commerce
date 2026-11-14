import { z } from 'zod'
import type { ApiClient } from '../../../../lib/api/client'

/**
 * The balance before shipping (B-W2b-386's API; FIN-079): the shipments the system holds because their order's
 * before-shipping step of the payment schedule is still open (GET /shipping/holds, reason BALANCE_UNPAID, in force), and
 * letting one go by hand with the reason (finance: shipping.holds.manage + shipping.holds.release). No money here: the open
 * balance is read from the customer's open items (payments.view, the price grain).
 */

export const balanceHoldSchema = z.object({
  id: z.string(),
  inForce: z.boolean(),
  bySystem: z.boolean(),
  placedAt: z.string(),
  mayRelease: z.boolean(),
  shipment: z.object({ id: z.string(), number: z.string(), status: z.string(), salesOrderId: z.string(), salesOrderNumber: z.string() }),
})
export type BalanceHold = z.infer<typeof balanceHoldSchema>

/** The shipments held for an unpaid balance, in force (shipping.view; up to 200). */
export async function balanceHolds(api: ApiClient, signal?: AbortSignal): Promise<BalanceHold[]> {
  return (await api.get('/shipping/holds', { query: { reason: 'BALANCE_UNPAID', state: 'IN_FORCE', limit: 200 }, schema: z.object({ holds: z.array(balanceHoldSchema) }), signal })).holds
}

/** Lets a held shipment go with the reason (the system then does not hold it again for that step). */
export async function releaseHold(api: ApiClient, hold: Pick<BalanceHold, 'id' | 'shipment'>, words: string, idempotencyKey: string): Promise<void> {
  await api.post(`/shipping/shipments/${encodeURIComponent(hold.shipment.id)}/holds/${encodeURIComponent(hold.id)}/release`, { body: { words }, schema: z.object({ holds: z.object({ held: z.boolean() }) }), idempotencyKey })
}

/** A live event that changes the holds or the balance behind them. */
export const balanceTouched = (change: { type: string }): boolean => change.type === 'shipment.hold_placed' || change.type === 'shipment.hold_released' || change.type.startsWith('payment.') || change.type === 'sales_order.schedule_changed'
