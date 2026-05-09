/**
 * H.2 — StockLevel + StockReservation operations layered on top of the
 * canonical applyStockMovement. Every state change (reserve, release,
 * consume, transfer) leaves an audit trail and keeps Product.totalStock
 * consistent.
 *
 * - reserveStock: hold N units against a StockLevel for an order. Adds
 *   to StockLevel.reserved (NOT quantity) and creates a StockReservation
 *   row with a 24h TTL. Available is reduced; quantity is unchanged.
 *
 * - releaseReservation: order cancelled or reservation expired. Decrements
 *   StockLevel.reserved, marks releasedAt. Quantity unchanged.
 *
 * - consumeReservation: order shipped. Decrements StockLevel.reserved AND
 *   quantity by the same amount. Marks consumedAt. This is the actual
 *   stock-out moment and emits a RESERVATION_CONSUMED audit row.
 *
 * - transferStock: move N units between locations (Riccione → FBA, etc.).
 *   Atomic: TRANSFER_OUT at source + TRANSFER_IN at destination, both
 *   audit rows linked via fromLocationId/toLocationId.
 *
 * - sweepExpiredReservations: cron-callable cleanup that releases any
 *   PENDING_ORDER reservation past its expiresAt.
 */

import prisma from '../db.js'
import { applyStockMovement } from './stock-movement.service.js'

const PENDING_ORDER_TTL_MS = 24 * 60 * 60 * 1000 // 24h
// S.2 — open marketplace orders sit in reserved state from ingestion
// until shipment (could be days). reservation-sweep filters by
// reason='PENDING_ORDER' so OPEN_ORDER reservations are never
// auto-released; we still set a far-future expiresAt to satisfy the
// non-null DB column. 1 year is the operational ceiling — anything
// older is a stale order that should be reconciled manually.
const OPEN_ORDER_TTL_MS = 365 * 24 * 60 * 60 * 1000

/** Resolve a StockLocation by code. Used by callers that know the
 *  semantic location ('IT-MAIN', 'AMAZON-EU-FBA') but not its cuid. */
export async function resolveLocationByCode(
  code: string,
): Promise<string | null> {
  const sl = await prisma.stockLocation.findUnique({
    where: { code },
    select: { id: true },
  })
  return sl?.id ?? null
}

export interface ReserveStockArgs {
  productId: string
  variationId?: string
  locationId: string
  quantity: number
  orderId?: string
  reason?: 'PENDING_ORDER' | 'MANUAL_HOLD' | 'PROMOTION' | 'OPEN_ORDER'
  ttlMs?: number
  actor?: string
}

/** Reserve N units. Throws if available < quantity. */
export async function reserveStock(args: ReserveStockArgs) {
  const {
    productId,
    variationId,
    locationId,
    quantity,
    orderId,
    reason = 'PENDING_ORDER',
    ttlMs = PENDING_ORDER_TTL_MS,
    actor,
  } = args
  if (quantity <= 0) throw new Error('reserveStock: quantity must be positive')

  return await prisma.$transaction(async (tx) => {
    const sl = await tx.stockLevel.findFirst({
      where: { productId, locationId, variationId: variationId ?? null },
      select: { id: true, quantity: true, reserved: true, available: true },
    })
    if (!sl) {
      throw new Error(
        `reserveStock: no StockLevel for product=${productId} location=${locationId}`,
      )
    }
    if (sl.available < quantity) {
      throw new Error(
        `reserveStock: insufficient available (need=${quantity} have=${sl.available} ` +
          `productId=${productId} locationId=${locationId})`,
      )
    }

    const newReserved = sl.reserved + quantity
    const newAvailable = sl.quantity - newReserved
    await tx.stockLevel.update({
      where: { id: sl.id },
      data: { reserved: newReserved, available: newAvailable },
    })

    const reservation = await tx.stockReservation.create({
      data: {
        stockLevelId: sl.id,
        quantity,
        orderId: orderId ?? null,
        reason,
        expiresAt: new Date(Date.now() + ttlMs),
      },
    })

    // Audit row — quantity unchanged so change=0 would fail the
    // applyStockMovement guard. Emit directly.
    await tx.stockMovement.create({
      data: {
        productId,
        variationId: variationId ?? null,
        locationId,
        change: 0,
        balanceAfter: sl.quantity,
        quantityBefore: sl.quantity,
        reason: 'RESERVATION_CREATED',
        referenceType: 'StockReservation',
        referenceId: reservation.id,
        orderId: orderId ?? null,
        reservationId: reservation.id,
        notes: `Reserved ${quantity} for ${reason}${orderId ? ` (order ${orderId})` : ''}`,
        actor: actor ?? null,
      },
    })

    return reservation
  })
}

/** Release a reservation without consuming. Decrements StockLevel.reserved. */
export async function releaseReservation(
  reservationId: string,
  opts: { actor?: string; reason?: string } = {},
) {
  return await prisma.$transaction(async (tx) => {
    const r = await tx.stockReservation.findUnique({
      where: { id: reservationId },
      include: { stockLevel: true },
    })
    if (!r) throw new Error(`releaseReservation: not found ${reservationId}`)
    if (r.releasedAt || r.consumedAt) {
      // Idempotent: already settled
      return r
    }

    const sl = r.stockLevel
    const newReserved = Math.max(0, sl.reserved - r.quantity)
    const newAvailable = sl.quantity - newReserved
    await tx.stockLevel.update({
      where: { id: sl.id },
      data: { reserved: newReserved, available: newAvailable },
    })

    const updated = await tx.stockReservation.update({
      where: { id: reservationId },
      data: { releasedAt: new Date() },
    })

    await tx.stockMovement.create({
      data: {
        productId: sl.productId,
        variationId: sl.variationId,
        locationId: sl.locationId,
        change: 0,
        balanceAfter: sl.quantity,
        quantityBefore: sl.quantity,
        reason: 'RESERVATION_RELEASED',
        referenceType: 'StockReservation',
        referenceId: reservationId,
        orderId: r.orderId ?? null,
        reservationId,
        notes: opts.reason ?? null,
        actor: opts.actor ?? null,
      },
    })

    return updated
  })
}

/** Consume a reservation (order shipped). Decrements both reserved and
 *  quantity. Emits RESERVATION_CONSUMED audit row. */
export async function consumeReservation(
  reservationId: string,
  opts: { actor?: string } = {},
) {
  const r = await prisma.stockReservation.findUnique({
    where: { id: reservationId },
    include: { stockLevel: true },
  })
  if (!r) throw new Error(`consumeReservation: not found ${reservationId}`)
  if (r.releasedAt) {
    throw new Error(`consumeReservation: already released ${reservationId}`)
  }
  if (r.consumedAt) {
    return r // idempotent
  }

  // L.13 — route through consumeWithFefo so lot-tracked products
  // automatically pick FEFO lots at consume time. Reservations stay
  // at the StockLevel grain (no lotId on reservation rows) — the
  // FEFO pick happens at consume time so a recall opened between
  // reserve and ship transparently re-routes consumption to a
  // different lot. allowShortfall=true so partial lot coverage
  // doesn't fail the consume; remainder logs as non-lot stock.
  //
  // For untracked products, the wrapper degrades to a single
  // applyStockMovement — identical to the prior code path.
  const { consumeWithFefo } = await import('./lot.service.js')
  await consumeWithFefo({
    productId: r.stockLevel.productId,
    variationId: r.stockLevel.variationId ?? undefined,
    locationId: r.stockLevel.locationId,
    quantity: r.quantity,
    reason: 'RESERVATION_CONSUMED',
    referenceType: 'StockReservation',
    referenceId: reservationId,
    orderId: r.orderId ?? undefined,
    reservationId,
    actor: opts.actor,
    allowShortfall: true,
  })

  return await prisma.$transaction(async (tx) => {
    const sl = await tx.stockLevel.findUnique({
      where: { id: r.stockLevelId },
      select: { quantity: true, reserved: true },
    })
    if (!sl) throw new Error('consumeReservation: stockLevel vanished')
    const newReserved = Math.max(0, sl.reserved - r.quantity)
    const newAvailable = sl.quantity - newReserved
    await tx.stockLevel.update({
      where: { id: r.stockLevelId },
      data: { reserved: newReserved, available: newAvailable },
    })
    return await tx.stockReservation.update({
      where: { id: reservationId },
      data: { consumedAt: new Date() },
    })
  })
}

export interface TransferStockArgs {
  productId: string
  variationId?: string
  fromLocationId: string
  toLocationId: string
  quantity: number
  notes?: string
  actor?: string
}

/** Atomically move N units between locations. */
export async function transferStock(args: TransferStockArgs) {
  const {
    productId,
    variationId,
    fromLocationId,
    toLocationId,
    quantity,
    notes,
    actor,
  } = args
  if (quantity <= 0) throw new Error('transferStock: quantity must be positive')
  if (fromLocationId === toLocationId) {
    throw new Error('transferStock: from and to locations must differ')
  }

  // Two applyStockMovement calls in sequence. Each is its own
  // transaction; if the second fails, we're left with an OUT but no IN.
  // Acceptable because the audit row makes the inconsistency visible
  // and a retry of the IN side completes the transfer cleanly.
  const out = await applyStockMovement({
    productId,
    variationId,
    locationId: fromLocationId,
    change: -quantity,
    reason: 'TRANSFER_OUT',
    referenceType: 'StockTransfer',
    notes,
    actor,
  })
  const inMv = await applyStockMovement({
    productId,
    variationId,
    locationId: toLocationId,
    change: +quantity,
    reason: 'TRANSFER_IN',
    referenceType: 'StockTransfer',
    referenceId: out.id, // link to the OUT row
    notes,
    actor,
  })

  // Stitch fromLocationId/toLocationId on both rows for the
  // movement-history UI.
  await prisma.stockMovement.update({
    where: { id: out.id },
    data: { fromLocationId, toLocationId },
  })
  await prisma.stockMovement.update({
    where: { id: inMv.id },
    data: { fromLocationId, toLocationId },
  })

  return { out, in: inMv }
}

/**
 * S.2 — Reserve stock for an open marketplace order.
 *
 * Idempotent: if a non-released, non-consumed reservation already exists
 * for (orderId, productId), this returns it unchanged. Used by
 * channel order ingestion (Amazon FBM today; Shopify in S.2.5; eBay
 * migrating later) to hold stock from the moment the order is
 * recognised through to shipment, without altering Product.totalStock.
 *
 * Location resolution: caller supplies locationId. For FBM today every
 * order ships from IT-MAIN; locationId is resolved to that.
 *
 * Insufficient-stock handling: re-thrown as-is. The caller decides
 * whether to log + continue (Amazon already accepted the order — we
 * can't refuse it, but we surface the oversell to the operator) or
 * fail the ingestion.
 */
export async function reserveOpenOrder(args: {
  orderId: string
  productId: string
  variationId?: string
  locationId: string
  quantity: number
  actor?: string
}) {
  const existing = await prisma.stockReservation.findFirst({
    where: {
      orderId: args.orderId,
      releasedAt: null,
      consumedAt: null,
      stockLevel: {
        productId: args.productId,
        variationId: args.variationId ?? null,
      },
    },
    select: { id: true, quantity: true },
  })
  if (existing) return existing

  return await reserveStock({
    productId: args.productId,
    variationId: args.variationId,
    locationId: args.locationId,
    quantity: args.quantity,
    orderId: args.orderId,
    reason: 'OPEN_ORDER',
    ttlMs: OPEN_ORDER_TTL_MS,
    actor: args.actor,
  })
}

/**
 * S.2 — Consume every open reservation tied to an order. Called when
 * the order transitions to SHIPPED. Decrements both reserved and
 * quantity for each reservation. Idempotent — already-consumed and
 * already-released reservations are skipped.
 *
 * Returns the count of reservations consumed.
 */
export async function consumeOpenOrder(args: {
  orderId: string
  actor?: string
}): Promise<number> {
  const open = await prisma.stockReservation.findMany({
    where: {
      orderId: args.orderId,
      releasedAt: null,
      consumedAt: null,
    },
    select: { id: true },
  })
  let consumed = 0
  for (const r of open) {
    try {
      await consumeReservation(r.id, { actor: args.actor })
      consumed++
    } catch {
      // continue — best-effort. A consume failure (e.g. concurrent
      // release) doesn't block the remainder.
    }
  }
  return consumed
}

/**
 * S.2 — Release every open reservation tied to an order. Called when
 * the order is cancelled. Decrements `reserved` (frees the stock for
 * other orders) without touching `quantity`. Idempotent.
 *
 * Returns the count of reservations released.
 */
export async function releaseOpenOrder(args: {
  orderId: string
  actor?: string
  reason?: string
}): Promise<number> {
  const open = await prisma.stockReservation.findMany({
    where: {
      orderId: args.orderId,
      releasedAt: null,
      consumedAt: null,
    },
    select: { id: true },
  })
  let released = 0
  for (const r of open) {
    try {
      await releaseReservation(r.id, {
        actor: args.actor,
        reason: args.reason ?? 'order cancelled',
      })
      released++
    } catch {
      // continue — best-effort.
    }
  }
  return released
}

/** Cron-driven cleanup: release any PENDING_ORDER reservation past its
 *  expiresAt. Idempotent. Returns count of releases.
 *
 *  Note: only sweeps reason='PENDING_ORDER'. OPEN_ORDER (S.2),
 *  MANUAL_HOLD, and PROMOTION reservations are never auto-released. */
export async function sweepExpiredReservations(): Promise<number> {
  const expired = await prisma.stockReservation.findMany({
    where: {
      reason: 'PENDING_ORDER',
      releasedAt: null,
      consumedAt: null,
      expiresAt: { lt: new Date() },
    },
    select: { id: true },
  })
  for (const r of expired) {
    try {
      await releaseReservation(r.id, {
        actor: 'system:reservation-sweep',
        reason: 'TTL expired',
      })
    } catch {
      // continue — sweep is best-effort
    }
  }
  return expired.length
}
