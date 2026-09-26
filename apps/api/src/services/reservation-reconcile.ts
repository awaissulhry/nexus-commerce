import prisma from '../db.js'
import { logger } from '../utils/logger.js'
import { consumeOpenOrder } from './stock-level.service.js'
import { noticeCancelledAfterShipment, settleCancelledOrderHolds } from './order-cancellation/index.js'
import { poolOpenHoldOrders } from './stock-pool/pool-doors.js'

/**
 * Phase 3 — decide what to do with an active OPEN_ORDER reservation whose
 * order has moved on. Conservative: only auto-act on unambiguous cases.
 *
 *   CANCELLED            -> release  (free the hold; after a partial shipment (C1) the units the
 *                                   channel says shipped are taken, and a hold it does not describe is
 *                                   kept — never released into stock)
 *   SHIPPED | DELIVERED  -> consume  (unit left; decrement quantity)
 *   REFUNDED | RETURNED  -> alert    (ambiguous; surface, don't auto-act)
 *   non-terminal & stale -> alert    (legitimately may still await fulfillment)
 *   otherwise            -> skip     (fresh, active — hold is correct)
 */
export type ReconcileAction = 'release' | 'consume' | 'alert' | 'skip'

const NON_TERMINAL = new Set([
  'PENDING',
  'PROCESSING',
  'PARTIALLY_SHIPPED',
  'ON_HOLD',
  'AWAITING_PAYMENT',
])

export function classifyOpenOrderReconciliation(
  orderStatus: string,
  ageMs: number,
  staleMs: number,
): ReconcileAction {
  if (orderStatus === 'CANCELLED') return 'release'
  if (orderStatus === 'SHIPPED' || orderStatus === 'DELIVERED') return 'consume'
  if (orderStatus === 'REFUNDED' || orderStatus === 'RETURNED') return 'alert'
  if (NON_TERMINAL.has(orderStatus)) return ageMs > staleMs ? 'alert' : 'skip'
  return 'skip'
}

const DEFAULT_STALE_MS = 90 * 24 * 60 * 60 * 1000 // 90d
const DEFAULT_MAX_ORDERS = 500

export async function reconcileOpenOrderReservations(opts?: {
  staleMs?: number
  maxOrders?: number
  actor?: string
}): Promise<{
  scanned: number
  released: number
  consumed: number
  alerted: number
  negativeAvailable: number
  capped: boolean
}> {
  const staleMs = opts?.staleMs ?? DEFAULT_STALE_MS
  const maxOrders = opts?.maxOrders ?? DEFAULT_MAX_ORDERS
  const actor = opts?.actor ?? 'reservation-reconcile'

  // Distinct orderIds with an active OPEN_ORDER reservation.
  const active = await prisma.stockReservation.findMany({
    where: { reason: 'OPEN_ORDER', releasedAt: null, consumedAt: null, orderId: { not: null } },
    select: { orderId: true },
    distinct: ['orderId'],
    take: maxOrders + 1,
  })
  // Shared stock step 4 — and this business's orders that hold stock in a pool. Those holds live in
  // the lender's ledger (this business cannot read them); the door lists the order references only.
  // releaseOpenOrder / consumeOpenOrder settle both kinds of hold.
  let pooledOrders: string[] = []
  try {
    pooledOrders = await poolOpenHoldOrders(prisma, maxOrders + 1)
  } catch (err) {
    logger.warn('reservation-reconcile: shared stock holds could not be listed', { err: err instanceof Error ? err.message : String(err) })
  }
  const ownOrders = active.map((r) => r.orderId!).filter(Boolean)
  const allOrders = [...new Set([...ownOrders, ...pooledOrders])]
  const capped = allOrders.length > maxOrders
  const orderIds = allOrders.slice(0, maxOrders)

  let released = 0
  let consumed = 0
  let alerted = 0

  if (orderIds.length > 0) {
    const orders = await prisma.order.findMany({
      where: { id: { in: orderIds } },
      select: { id: true, status: true, updatedAt: true },
    })
    // Surface reservations whose order no longer exists (hard-deleted / missing
    // FK). Without this they'd be re-scanned every run, never actioned, never
    // seen. Conservative: alert + count, never touch stock.
    const foundIds = new Set(orders.map((o) => o.id))
    const orphanIds = orderIds.filter((id) => !foundIds.has(id))
    if (orphanIds.length > 0) {
      alerted += orphanIds.length
      logger.warn('reservation-reconcile: reservations reference unknown orders', {
        count: orphanIds.length,
        sample: orphanIds.slice(0, 5),
      })
    }
    const now = Date.now()
    for (const o of orders) {
      const ageMs = now - o.updatedAt.getTime()
      const action = classifyOpenOrderReconciliation(String(o.status), ageMs, staleMs)
      try {
        if (action === 'release') {
          const settled = await settleCancelledOrderHolds(o.id, { reason: 'reconcile: order terminal (cancelled)', actor })
          released += settled.released
          consumed += settled.consumed
          // The same notice E3 raises (one per order), in case the cancellation never ran its cascade.
          if (settled.shipped) await noticeCancelledAfterShipment(o.id, { putBack: settled.releasedUnits, kept: settled.kept })
        } else if (action === 'consume') {
          consumed += await consumeOpenOrder({ orderId: o.id, actor })
        } else if (action === 'alert') {
          alerted++
          logger.warn('reservation-reconcile: open reservation needs review', {
            orderId: o.id,
            status: o.status,
            ageDays: Math.round(ageMs / (24 * 60 * 60 * 1000)),
          })
        }
      } catch (err) {
        logger.warn('reservation-reconcile: action failed (non-fatal)', {
          orderId: o.id,
          action,
          err: err instanceof Error ? err.message : String(err),
        })
      }
    }
  }

  // Cheap negative-available surfacing (if the DB CHECK ever lets one through).
  const negativeAvailable = await prisma.stockLevel.count({ where: { available: { lt: 0 } } })
  if (negativeAvailable > 0) {
    logger.warn('reservation-reconcile: negative available detected', { count: negativeAvailable })
  }

  if (capped) {
    logger.warn('reservation-reconcile: order scan capped', { maxOrders })
  }

  return { scanned: orderIds.length, released, consumed, alerted, negativeAvailable, capped }
}
