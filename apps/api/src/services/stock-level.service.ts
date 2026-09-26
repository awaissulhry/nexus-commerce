import { workspaceKey } from '@nexus/database/workspace-context'
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
import type { Prisma } from '@prisma/client'
import { afterStockMovementCommit, applyStockMovement } from './stock-movement.service.js'
import { lockProductStock } from './stock-lock.js'
import { pooledNow, PoolHoldError, PooledProductError } from './stock-pool/pool-guard.js'
import { consumePoolHolds, holdForOrder, releasePoolHolds } from './stock-pool/order-routing.js'
// EV.2 — reservation facts, published inside each reservation's own transaction.
import { publishEvent } from '../lib/events/publish.js'
import { logger } from '../utils/logger.js'

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
    where: { workspace_code: workspaceKey({ code: code }) },
    select: { id: true },
  })
  if (!sl && code === 'IT-MAIN') return (await (await import('./default-stock-location.js')).defaultStockLocation())?.id ?? null
  return sl?.id ?? null
}

export interface ReserveStockArgs {
  productId: string
  variationId?: string
  locationId: string
  quantity: number
  orderId?: string
  reason?: 'PENDING_ORDER' | 'MANUAL_HOLD' | 'PROMOTION' | 'OPEN_ORDER' | 'CART_HOLD'
  /** RV.1 — HARD decrements StockLevel.reserved (default, all
   *  existing callers). SOFT is advisory: row exists but doesn't
   *  decrement available. Used for cart hold / payment-pending so
   *  ATP-soft can subtract carts while ATP-hard stays at confirmed-
   *  orders only. */
  kind?: 'SOFT' | 'HARD'
  ttlMs?: number
  actor?: string
}

/** Reserve N units. Throws if available < quantity. */
export async function reserveStock(args: ReserveStockArgs) {
  if (args.quantity <= 0) throw new Error('reserveStock: quantity must be positive')
  return await prisma.$transaction((tx) => reserveStockInTx(tx, args))
}

/** reserveStock inside a transaction the caller owns. Takes the product stock lock first. */
async function reserveStockInTx(tx: Prisma.TransactionClient, args: ReserveStockArgs) {
  const {
    productId,
    variationId,
    locationId,
    quantity,
    orderId,
    reason = 'PENDING_ORDER',
    kind = 'HARD',
    ttlMs = PENDING_ORDER_TTL_MS,
    actor,
  } = args
  if (quantity <= 0) throw new Error('reserveStock: quantity must be positive')

  // AE.1 — lock before reading `available`: two buyers must not both see the last unit.
  await lockProductStock(tx, [productId])

  // Shared stock step 4 — an order's hold on a warehouse, for a product that sells from a pool, is
  // held in the pool (reserveOpenOrder routes it there). One that reaches own stock anyway came
  // through a path nobody routed: refuse it rather than hold stock no listing shows.
  if (reason === 'OPEN_ORDER') {
    const location = await tx.stockLocation.findUnique({ where: { id: locationId }, select: { type: true } })
    if (location?.type === 'WAREHOUSE' && (await pooledNow(tx, [productId])).has(productId)) {
      throw new PooledProductError(productId, "an order's hold")
    }
  }

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

  // RV.1 — only HARD reservations decrement StockLevel.reserved.
  // SOFT is visible in the StockReservation table but doesn't
  // affect available calculations.
  let availableAfter = sl.available
  if (kind === 'HARD') {
    const newReserved = sl.reserved + quantity
    const newAvailable = sl.quantity - newReserved
    availableAfter = newAvailable
    await tx.stockLevel.update({
      where: { id: sl.id },
      data: { reserved: newReserved, available: newAvailable },
    })
  }

  const reservation = await tx.stockReservation.create({
    data: {
      stockLevelId: sl.id,
      quantity,
      orderId: orderId ?? null,
      reason,
      kind,
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

  // EV.2 — same transaction as the reservation itself.
  await publishEvent(tx, 'inventory.reserved', {
    productId,
    reservationId: reservation.id,
    locationId,
    quantity,
    kind: kind === 'SOFT' ? 'SOFT' : 'HARD',
    availableAfter,
    orderId: orderId ?? null,
  })

  return reservation
}

/** Release a reservation without consuming. Decrements StockLevel.reserved. */
export async function releaseReservation(
  reservationId: string,
  opts: { actor?: string; reason?: string; tx?: Prisma.TransactionClient } = {},
) {
  // In the caller's transaction when it passes one (a capped consume gives back a surplus hold under
  // the lock it already holds); otherwise in its own.
  const settle = async (tx: Prisma.TransactionClient) => {
    const target = await tx.stockReservation.findUnique({
      where: { id: reservationId },
      select: { stockLevel: { select: { productId: true } } },
    })
    if (!target) throw new Error(`releaseReservation: not found ${reservationId}`)
    // AE.1 — lock, THEN read the reservation and its level: a concurrent release or
    // consume may have settled it while this call waited for the lock.
    await lockProductStock(tx, [target.stockLevel.productId])
    const r = await tx.stockReservation.findUnique({
      where: { id: reservationId },
      include: { stockLevel: true },
    })
    if (!r) throw new Error(`releaseReservation: not found ${reservationId}`)
    if (r.releasedAt || r.consumedAt) {
      // Idempotent: already settled
      return r
    }
    // Shared stock — a hold made here for another business's order is not this business's to release.
    if (r.consumerWorkspaceId) throw new PoolHoldError(r.id)

    const sl = r.stockLevel
    // RV.1 — only HARD reservations affected StockLevel.reserved on
    // creation; only HARD reservations decrement it on release. SOFT
    // releases just mark the row.
    const isHard = (r.kind ?? 'HARD') === 'HARD'
    const newReserved = isHard ? Math.max(0, sl.reserved - r.quantity) : sl.reserved
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

    await publishEvent(tx, 'inventory.reservation_released', {
      productId: sl.productId,
      reservationId,
      quantity: r.quantity,
      kind: isHard ? 'HARD' : 'SOFT',
      availableAfter: newAvailable,
      reason: opts.reason ?? null,
    })

    return updated
  }
  return opts.tx ? await settle(opts.tx) : await prisma.$transaction(settle)
}

/** Consume a reservation (order shipped). Decrements both reserved and
 *  quantity. Emits RESERVATION_CONSUMED audit row.
 *
 *  AE.1 — ONE transaction under the product stock lock. Before AE.1 the "already consumed"
 *  check ran outside any transaction and the stock left in one transaction while `reserved`
 *  dropped in a second: two concurrent calls both passed the check and took the stock twice
 *  (measured), and a crash between the two left `reserved` inflated for good.
 *
 *  `capToOrder` (consumeOpenOrder): of a hold of an order, only what the order still owes of the
 *  product is taken; the rest is released (all of it when nothing is owed — the returned row then
 *  has `releasedAt`, not `consumedAt`). */
export async function consumeReservation(
  reservationId: string,
  opts: { actor?: string; capToOrder?: boolean } = {},
) {
  const outcome = await prisma.$transaction(async (tx) => {
    const target = await tx.stockReservation.findUnique({
      where: { id: reservationId },
      select: { stockLevel: { select: { productId: true } } },
    })
    if (!target) throw new Error(`consumeReservation: not found ${reservationId}`)
    await lockProductStock(tx, [target.stockLevel.productId])

    const r = await tx.stockReservation.findUnique({
      where: { id: reservationId },
      include: { stockLevel: true },
    })
    if (!r) throw new Error(`consumeReservation: not found ${reservationId}`)
    if (r.releasedAt) {
      throw new Error(`consumeReservation: already released ${reservationId}`)
    }
    if (r.consumedAt) {
      return { consumed: r, committed: [] } // idempotent
    }
    // A hold beyond what the order still owes (a re-read of an order whose units had already left,
    // or a line lowered after its hold): taking all of it would take units the order does not owe.
    // Take only what is still owed and give the rest back — all of it when nothing is owed. Under
    // this same lock, so a consume racing on the same order is counted.
    let take = r.quantity
    if (opts.capToOrder && r.orderId) {
      const due = await owedToOrder(tx, r.orderId, r.stockLevel.productId)
      if (r.quantity > due.owed) {
        take = Math.max(0, due.owed)
        const surplus = r.quantity - take
        const reason = `surplus hold: the order still owes ${take} of this product, the hold is ${r.quantity}`
        logger.warn('stock: surplus order hold released, not consumed', {
          reservationId, orderId: r.orderId, productId: r.stockLevel.productId, quantity: r.quantity, ordered: due.ordered, taken: due.taken, owed: take, released: surplus,
        })
        if (take === 0) {
          const released = await releaseReservation(reservationId, { actor: opts.actor, reason, tx })
          return { consumed: released, committed: [] }
        }
        // Split, on this one reservation (one audit trail): the surplus is given back here — no stock
        // leaves, and `reserved` drops by the whole hold in the one settle below — and `take` is consumed.
        const isHard = (r.kind ?? 'HARD') === 'HARD'
        await tx.stockMovement.create({
          data: {
            productId: r.stockLevel.productId,
            variationId: r.stockLevel.variationId,
            locationId: r.stockLevel.locationId,
            change: 0,
            balanceAfter: r.stockLevel.quantity,
            quantityBefore: r.stockLevel.quantity,
            reason: 'RESERVATION_RELEASED',
            referenceType: 'StockReservation',
            referenceId: reservationId,
            orderId: r.orderId,
            reservationId,
            notes: `${reason}: ${surplus} given back, ${take} taken`,
            actor: opts.actor ?? null,
          },
        })
        await publishEvent(tx, 'inventory.reservation_released', {
          productId: r.stockLevel.productId,
          reservationId,
          quantity: surplus,
          kind: isHard ? 'HARD' : 'SOFT',
          availableAfter: r.stockLevel.quantity - (isHard ? Math.max(0, r.stockLevel.reserved - surplus) : r.stockLevel.reserved),
          reason,
        })
      }
    }

    // Settle `reserved` BEFORE the stock leaves, so the cascade inside the movement below
    // computes available from the final state (quantity − 3 and reserved − 3 together)
    // instead of publishing a quantity 3 too low. RV.1 — only HARD reservations ever
    // added to `reserved`. The WHOLE hold leaves `reserved` (a split's surplus included);
    // only `take` leaves `quantity`.
    if ((r.kind ?? 'HARD') === 'HARD') {
      const newReserved = Math.max(0, r.stockLevel.reserved - r.quantity)
      await tx.stockLevel.update({
        where: { id: r.stockLevelId },
        data: { reserved: newReserved, available: r.stockLevel.quantity - newReserved },
      })
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
    // movement — identical to the prior code path.
    const { consumeWithFefo } = await import('./lot.service.js')
    const fefo = await consumeWithFefo({
      productId: r.stockLevel.productId,
      variationId: r.stockLevel.variationId ?? undefined,
      locationId: r.stockLevel.locationId,
      quantity: take,
      reason: 'RESERVATION_CONSUMED',
      referenceType: 'StockReservation',
      referenceId: reservationId,
      orderId: r.orderId ?? undefined,
      reservationId,
      actor: opts.actor,
      allowShortfall: true,
      tx,
    })

    // A split hold keeps only what it took: "taken" is read from consumed holds' quantities.
    const consumed = await tx.stockReservation.update({
      where: { id: reservationId },
      data: { consumedAt: new Date(), quantity: take },
    })

    // The stock leaving was already published as inventory.stock_changed by
    // the movement above. This records that the RESERVATION settled, which is
    // a different fact: it is what closes the promise made to a buyer.
    await publishEvent(tx, 'inventory.reservation_consumed', {
      productId: r.stockLevel.productId,
      reservationId,
      quantity: take,
      kind: (r.kind ?? 'HARD') === 'SOFT' ? 'SOFT' : 'HARD',
      orderId: r.orderId ?? null,
    })

    return { consumed, committed: fefo.committed }
  })

  for (const committed of outcome.committed) {
    await afterStockMovementCommit({ productId: committed.movement.productId, reason: 'RESERVATION_CONSUMED' }, committed)
  }
  return outcome.consumed
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
 * for (orderId, productId), this returns it unchanged. Units already
 * consumed for (orderId, productId) are never held again: it holds only
 * `quantity` minus those, and nothing once none remain. Used by
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
  // Shared stock step 4 — a product that sells from a pool is held in the pool, from the lender's
  // lent warehouses (door 2: one hold per order and product, ever — a re-polled order is never held
  // twice). Only for a warehouse hold: an Amazon FBA hold (MCF) is this business's own, never pooled.
  const location = await prisma.stockLocation.findUnique({ where: { id: args.locationId }, select: { type: true } })
  if (location?.type === 'WAREHOUSE') {
    const routed = await holdForOrder({ productId: args.productId, quantity: args.quantity, orderId: args.orderId, actor: args.actor ?? 'system' })
    if (routed.via === 'pool') return { id: routed.result.reservationId, quantity: routed.result.quantity }
    if (routed.via === 'refused') throw new Error(`reserveOpenOrder: ${routed.refusal.error}`)
  }
  return await prisma.$transaction(async (tx) => {
    // AE.1 — the "already reserved?" check runs under the same lock as the reservation.
    // Checked outside it, a webhook and a poll for one order both found nothing and both
    // reserved (measured: two reservations for one order).
    await lockProductStock(tx, [args.productId])
    const line = { orderId: args.orderId, stockLevel: { productId: args.productId, variationId: args.variationId ?? null } }
    const existing = await tx.stockReservation.findFirst({
      where: { ...line, releasedAt: null, consumedAt: null },
      select: { id: true, quantity: true },
    })
    if (existing) return existing

    // "Held" is not only "held now": a re-read of an order that already shipped found no OPEN hold,
    // held its units again, and the reconcile took them a second time. Units this line already took
    // are never held again: hold only what is still owed; nothing once all of it is taken (the hold
    // that took the last of it is returned). Same lock, so a consume in flight is counted.
    const took = await tx.stockReservation.findMany({
      where: { ...line, consumedAt: { not: null } },
      select: { id: true, quantity: true },
      orderBy: [{ consumedAt: 'desc' }, { id: 'desc' }],
    })
    const owed = args.quantity - took.reduce((sum, r) => sum + r.quantity, 0)
    if (took.length > 0 && owed <= 0) return took[0]

    return await reserveStockInTx(tx, {
      productId: args.productId,
      variationId: args.variationId,
      locationId: args.locationId,
      quantity: owed,
      orderId: args.orderId,
      reason: 'OPEN_ORDER',
      ttlMs: OPEN_ORDER_TTL_MS,
      actor: args.actor,
    })
  })
}

/**
 * What an order still owes of a product: its lines' units minus what its own holds already took.
 * OrderItem carries no variation, so both sides are counted per product. With no line for the
 * product (an unlinked SKU, a hold for an item not on the order) the ordered quantity is unknown:
 * the first hold may be taken, and none after one was — a later one is the re-read pattern.
 */
async function owedToOrder(tx: Prisma.TransactionClient, orderId: string, productId: string) {
  const lines = await tx.orderItem.aggregate({ where: { orderId, productId }, _sum: { quantity: true }, _count: { _all: true } })
  const took = await tx.stockReservation.aggregate({
    where: { orderId, consumedAt: { not: null }, stockLevel: { productId } },
    _sum: { quantity: true },
  })
  const taken = took._sum.quantity ?? 0
  const ordered = lines._count._all > 0 ? (lines._sum.quantity ?? 0) : null
  return { ordered, taken, owed: ordered === null ? (taken > 0 ? 0 : Infinity) : ordered - taken }
}

/**
 * S.2 — Consume every open reservation tied to an order. Called when
 * the order transitions to SHIPPED. Decrements both reserved and
 * quantity for each reservation. Idempotent — already-consumed and
 * already-released reservations are skipped. Never takes more of a
 * product than the order still owes: a hold's surplus is released
 * (consumeReservation `capToOrder`).
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
      const settled = await consumeReservation(r.id, { actor: args.actor, capToOrder: true })
      if (settled.consumedAt) consumed++
    } catch {
      // continue — best-effort. A consume failure (e.g. concurrent
      // release) doesn't block the remainder.
    }
  }
  // Shared stock step 4 — and the order's holds in a pool (door 4a finds only this order's own).
  try {
    consumed += await consumePoolHolds({ orderId: args.orderId, actor: args.actor })
  } catch {
    // best-effort, like the own holds above; the reconcile job retries.
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
  // Shared stock step 4 — and the order's holds in a pool (door 3 finds only this order's own).
  try {
    released += await releasePoolHolds({ orderId: args.orderId, actor: args.actor, reason: args.reason ?? 'order cancelled' })
  } catch {
    // best-effort, like the own holds above; the reconcile job retries.
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
