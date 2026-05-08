/**
 * O.16a — Amazon Account Health metrics computed from local data.
 *
 * Amazon's Seller Performance dashboard tracks two ship-quality
 * metrics that gate Buy Box + selling privileges for FBM:
 *
 *   LSR (Late Shipment Rate)   = late orders / shipped orders in
 *                                a rolling 30-day window
 *                                Threshold for warning: 4%
 *                                Threshold for action: 10%
 *
 *   VTR (Valid Tracking Rate)  = orders with valid tracking /
 *                                total shipped orders, 30 days
 *                                Threshold: 95% (under = penalty)
 *
 * Amazon's SP-API GetAccountHealth endpoint returns the official
 * numbers, but we don't need to round-trip for an at-a-glance
 * widget — local Order data has every input. SP-API integration
 * lands when we need the exact-match number for compliance proof
 * (a separate commit, env-flag-gated).
 *
 * "Late" definition: order shippedAt > shipByDate. Orders without
 * shipByDate (e.g. legacy rows pre-O.1) are excluded — neither
 * counted as late nor as denominator. Orders without shippedAt
 * are excluded from both metrics (haven't shipped yet, so they
 * can't be measured).
 *
 * Window: rolling 30 days from now, anchored on shippedAt.
 */

import prisma from '../db.js'

export const LSR_WARNING_THRESHOLD = 0.04 // 4%
export const LSR_ACTION_THRESHOLD = 0.1 // 10%
export const VTR_THRESHOLD = 0.95 // 95%

export interface AccountHealth {
  windowStart: string
  windowEnd: string
  /** Total Amazon FBM orders shipped in the window. */
  shippedOrders: number
  /** Of those, how many shipped after shipByDate. */
  lateShipments: number
  lsr: number
  lsrTier: 'green' | 'yellow' | 'red'
  /** Of shipped orders, how many had a valid tracking number on at
   *  least one shipment row. */
  ordersWithTracking: number
  vtr: number
  vtrTier: 'green' | 'red'
}

export async function computeAmazonAccountHealth(): Promise<AccountHealth> {
  const windowEnd = new Date()
  const windowStart = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000)

  // Pull every Amazon FBM order shipped in the window. FBA is
  // excluded — those metrics are Amazon's responsibility, not the
  // seller's.
  const orders = await prisma.order.findMany({
    where: {
      channel: 'AMAZON',
      fulfillmentMethod: 'FBM',
      shippedAt: { gte: windowStart, lte: windowEnd },
    },
    select: {
      id: true,
      shipByDate: true,
      shippedAt: true,
      shipments: {
        select: { trackingNumber: true },
      },
    },
  })

  let lateShipments = 0
  let ordersWithTracking = 0
  let shippedOrdersWithShipByDate = 0

  for (const o of orders) {
    if (o.shipByDate && o.shippedAt) {
      shippedOrdersWithShipByDate++
      if (o.shippedAt > o.shipByDate) lateShipments++
    }
    if (o.shipments.some((s) => s.trackingNumber && s.trackingNumber.trim() !== '')) {
      ordersWithTracking++
    }
  }

  const shippedOrders = orders.length
  const lsr =
    shippedOrdersWithShipByDate === 0
      ? 0
      : lateShipments / shippedOrdersWithShipByDate
  const vtr = shippedOrders === 0 ? 1 : ordersWithTracking / shippedOrders

  const lsrTier: 'green' | 'yellow' | 'red' =
    lsr >= LSR_ACTION_THRESHOLD
      ? 'red'
      : lsr >= LSR_WARNING_THRESHOLD
        ? 'yellow'
        : 'green'
  const vtrTier: 'green' | 'red' = vtr >= VTR_THRESHOLD ? 'green' : 'red'

  return {
    windowStart: windowStart.toISOString(),
    windowEnd: windowEnd.toISOString(),
    shippedOrders,
    lateShipments,
    lsr,
    lsrTier,
    ordersWithTracking,
    vtr,
    vtrTier,
  }
}

/**
 * Per-order "ship-by impact" label. Returns a tier + reason for
 * the order detail's at-a-glance widget.
 *
 * Tiers map to Amazon's view of THIS specific order:
 *   on-time   — shipped before shipByDate
 *   at-risk   — not shipped yet, < 24h from shipByDate
 *   overdue   — not shipped yet, past shipByDate
 *   late      — shipped, but after shipByDate (will count toward LSR)
 *   no-track  — shipped, but no shipment row carries a tracking number
 *               (will count against VTR even when on-time)
 *   na        — order isn't FBM Amazon, or has no shipByDate to gate on
 */
export function perOrderShipByTier(o: {
  channel: string
  fulfillmentMethod: string | null
  shipByDate: Date | string | null
  shippedAt: Date | string | null
  shipments?: Array<{ trackingNumber: string | null }>
}): { tier: 'on-time' | 'at-risk' | 'overdue' | 'late' | 'no-track' | 'na'; reason: string } {
  if (o.channel !== 'AMAZON' || o.fulfillmentMethod !== 'FBM') {
    return { tier: 'na', reason: 'Not Amazon FBM — LSR/VTR not applicable' }
  }
  const shipBy = o.shipByDate ? new Date(o.shipByDate) : null
  const shippedAt = o.shippedAt ? new Date(o.shippedAt) : null

  if (shippedAt) {
    const lateBy = shipBy ? shippedAt.getTime() - shipBy.getTime() : 0
    const hasTracking = (o.shipments ?? []).some(
      (s) => s.trackingNumber && s.trackingNumber.trim() !== '',
    )
    if (shipBy && lateBy > 0) {
      const hours = Math.round(lateBy / (60 * 60 * 1000))
      return { tier: 'late', reason: `Shipped ${hours}h past ship-by — counts toward LSR` }
    }
    if (!hasTracking) {
      return { tier: 'no-track', reason: 'Shipped without tracking — counts against VTR' }
    }
    return { tier: 'on-time', reason: 'Shipped on time with tracking' }
  }

  if (!shipBy) return { tier: 'na', reason: 'No ship-by date on this order' }
  const msToShipBy = shipBy.getTime() - Date.now()
  if (msToShipBy < 0) {
    const hours = Math.round(-msToShipBy / (60 * 60 * 1000))
    return { tier: 'overdue', reason: `Past ship-by by ${hours}h — LSR risk` }
  }
  if (msToShipBy < 24 * 60 * 60 * 1000) {
    const hours = Math.round(msToShipBy / (60 * 60 * 1000))
    return { tier: 'at-risk', reason: `${hours}h until ship-by` }
  }
  return { tier: 'on-time', reason: 'On track' }
}
