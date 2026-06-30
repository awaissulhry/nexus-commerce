import prisma from '../db.js'
import { logger } from '../utils/logger.js'
import { releaseOpenOrder, consumeOpenOrder } from './stock-level.service.js'

/**
 * Phase 3 — decide what to do with an active OPEN_ORDER reservation whose
 * order has moved on. Conservative: only auto-act on unambiguous cases.
 *
 *   CANCELLED            -> release  (never shipped; free the hold)
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
  const capped = active.length > maxOrders
  const orderIds = active.slice(0, maxOrders).map((r) => r.orderId!).filter(Boolean)

  let released = 0
  let consumed = 0
  let alerted = 0

  if (orderIds.length > 0) {
    const orders = await prisma.order.findMany({
      where: { id: { in: orderIds } },
      select: { id: true, status: true, updatedAt: true },
    })
    const now = Date.now()
    for (const o of orders) {
      const ageMs = now - o.updatedAt.getTime()
      const action = classifyOpenOrderReconciliation(String(o.status), ageMs, staleMs)
      try {
        if (action === 'release') {
          released += await releaseOpenOrder({ orderId: o.id, reason: 'reconcile: order terminal (cancelled)', actor })
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
