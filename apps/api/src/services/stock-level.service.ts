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
import { afterStockMovementCommit, applyStockMovementInTx, InsufficientStockError, type StockMovementTxResult } from './stock-movement.service.js'
import { lockProductStock } from './stock-lock.js'
import { pooledNow, PoolHoldError, PooledProductError } from './stock-pool/pool-guard.js'
import { consumePoolHolds, releasePoolHolds, reportPoolOrderRefusal } from './stock-pool/order-routing.js'
import { poolConsume, poolLenderRelease, poolOrderHold, poolOrderTaken, poolPutBack, poolRelease, poolReserve, refusalOf, type PoolRefusal } from './stock-pool/pool-doors.js'
import { afterPoolChange } from './stock-pool/pool-tasks.js'
import { saleLocationInTx, type SaleRoute } from './stock/sale-location.service.js'
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

/**
 * No stock level for the product at the location, so nothing can be held there. The message is the
 * one reserveStock always threw; the class lets an order writer record it on the line (R5) instead of
 * failing the whole order.
 */
export class StockLevelMissingError extends Error {
  readonly code = 'no_stock_level'
  constructor(readonly productId: string, readonly locationId: string) {
    super(`reserveStock: no StockLevel for product=${productId} location=${locationId}`)
    this.name = 'StockLevelMissingError'
  }
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
  if (!sl) throw new StockLevelMissingError(productId, locationId)
  if (sl.available < quantity) {
    throw InsufficientStockError.forHold(quantity, sl.available, productId, locationId)
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
  return opts.tx ? await releaseReservationInTx(opts.tx, reservationId, opts) : await prisma.$transaction(async (tx) => releaseReservationInTx(tx, reservationId, opts))
}

/**
 * The stock page's Release (POST /stock/release/:id). This business's own holds: releaseReservation.
 * A hold of this business's stock for ANOTHER business's order (shared stock) is refused, except in
 * the one case nobody else can settle (re-review 2026-09-26): that business cancelled or refunded the
 * order and could not tell whether the units shipped, so its cancellation KEPT the hold. Then the
 * lender releases it (door `nexus_pool_lender_release`: lender only, checked in the database; the
 * movement names the actor and why). The page asks for confirmation before it calls this.
 */
export async function releaseReservationFromStockPage(reservationId: string, opts: { actor?: string } = {}) {
  try {
    return await releaseReservation(reservationId, { actor: opts.actor })
  } catch (error) {
    if (!(error instanceof PoolHoldError)) throw error
    const answer = await poolLenderRelease(prisma, { reservationId, actor: opts.actor ?? null })
    const refusal = refusalOf(answer)
    if (refusal) {
      if (refusal.code === 'pool_hold') throw error
      throw Object.assign(new Error(refusal.error), { code: refusal.code, statusCode: refusal.status })
    }
    if (!(answer as Extract<typeof answer, { ok: true }>).reused) afterPoolChange()
    return await prisma.stockReservation.findUniqueOrThrow({ where: { id: reservationId } })
  }
}

/** releaseReservation's work inside a transaction the caller owns. Idempotent on a settled row. */
async function releaseReservationInTx(
  tx: Prisma.TransactionClient,
  reservationId: string,
  opts: { actor?: string; reason?: string },
) {
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
  const outcome = await prisma.$transaction(async (tx) => consumeReservationInTx(tx, reservationId, opts))

  for (const committed of outcome.committed) {
    await afterStockMovementCommit({ productId: committed.movement.productId, reason: 'RESERVATION_CONSUMED' }, committed)
  }
  return outcome.consumed
}

/**
 * consumeReservation's work inside a transaction the caller owns. `committed` is the post-commit
 * work (instant-lane push, stockout hook, read cache) for the caller to run once it has committed.
 */
async function consumeReservationInTx(
  tx: Prisma.TransactionClient,
  reservationId: string,
  /** `takeAtMost` (C1, a cancellation after a partial shipment): take no more than the units the
   *  channel says shipped; the rest of the hold is given back in the same split. */
  opts: { actor?: string; capToOrder?: boolean; takeAtMost?: number; reason?: string },
) {
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
  const due = opts.capToOrder && r.orderId ? await owedToOrder(tx, r.orderId, r.stockLevel.productId) : null
  const cap = Math.min(due ? due.owed : Infinity, opts.takeAtMost ?? Infinity)
  if (r.quantity > cap) {
    take = Math.max(0, cap)
    const surplus = r.quantity - take
    const surplusHold = due !== null && due.owed <= (opts.takeAtMost ?? Infinity)
    const reason = surplusHold
      ? `surplus hold: the order still owes ${take} of this product, the hold is ${r.quantity}`
      : `${opts.reason ?? 'order cancelled'} after a partial shipment: ${take} shipped, the hold is ${r.quantity}`
    logger.warn(surplusHold ? 'stock: surplus order hold released, not consumed' : 'stock: cancelled order hold split at what shipped', {
      reservationId, orderId: r.orderId, productId: r.stockLevel.productId, quantity: r.quantity, ordered: due?.ordered, taken: due?.taken, owed: due?.owed, takeAtMost: opts.takeAtMost, released: surplus,
    })
    if (take === 0) {
      const released = await releaseReservationInTx(tx, reservationId, { actor: opts.actor, reason })
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

/**
 * Atomically move N units between locations.
 *
 * MCP full control 08 S2 (F8) — ONE transaction: the OUT and the IN movement (with their from/to stamps) commit
 * together or not at all. Before, they were two transactions, so a failure between them left the units gone from the
 * source and arrived nowhere, and every reader in between saw them missing. A protected location on either side
 * (F7: the FBA mirror, a Shopify location) is refused before anything is written.
 */
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

  const outInput = {
    productId,
    variationId,
    locationId: fromLocationId,
    change: -quantity,
    reason: 'TRANSFER_OUT' as const,
    referenceType: 'StockTransfer',
    notes,
    actor,
  }
  const committed = await prisma.$transaction(async (tx) => {
    const out = await applyStockMovementInTx(tx, outInput)
    const inMv = await applyStockMovementInTx(tx, {
      productId,
      variationId,
      locationId: toLocationId,
      change: +quantity,
      reason: 'TRANSFER_IN',
      referenceType: 'StockTransfer',
      referenceId: out.movement.id, // link to the OUT row
      notes,
      actor,
    })
    // Stitch fromLocationId/toLocationId on both rows for the movement-history UI.
    const stamped = await Promise.all([out.movement.id, inMv.movement.id].map((id) =>
      tx.stockMovement.update({ where: { id }, data: { fromLocationId, toLocationId } })))
    return { out, inMv, stamped }
  })

  // After the commit: the queue push, stockout hook and read-cache refresh of each movement.
  await afterStockMovementCommit({ productId, reason: 'TRANSFER_OUT' }, committed.out)
  await afterStockMovementCommit({ productId, reason: 'TRANSFER_IN' }, committed.inMv)

  return { out: committed.stamped[0], in: committed.stamped[1] }
}

/**
 * R10 — what an order holds and takes is per PRODUCT: one hold per (order, product), sized to the
 * product's units over ALL of the order's lines. Callers sum here before asking for a hold (two lines
 * of one product held only the first line's units). Lines without a product or units are left out.
 */
export function unitsPerProduct<T extends { productId: string | null; quantity: number }>(lines: T[]): Array<{ productId: string; quantity: number; lines: T[] }> {
  const out = new Map<string, { productId: string; quantity: number; lines: T[] }>()
  for (const line of lines) {
    if (!line.productId || !(line.quantity > 0)) continue
    const entry = out.get(line.productId) ?? { productId: line.productId, quantity: 0, lines: [] }
    entry.quantity += line.quantity
    entry.lines.push(line)
    out.set(line.productId, entry)
  }
  return [...out.values()]
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
 * Location resolution: caller supplies locationId (IT-MAIN, else the default warehouse). Step 2 —
 * "Sells from": with `sale` (the channel, market and account of the order), a NEW warehouse hold is
 * made at the first location of the market's "Sells from" list that has enough available, picked
 * inside the transaction after the lock (`saleLocationInTx`); `locationId` stays the fallback for a
 * pooled product, one with no routed row, or a market that cannot be told.
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
  /** Step 2 — where the order sold: its warehouse hold is picked from that market's "Sells from" list. */
  sale?: SaleRoute
}) {
  // ONE transaction, as the channel writers run it (review B1): the order-stock lock door first — the
  // product, its pool sources and the pool-link lock — then the side is decided and the hold made
  // under it. Decided outside any lock, a link switch between the decision and the own hold's commit
  // let a second read hold the order again in the pool. A warehouse hold only: an FBA hold (MCF) is
  // this business's own, never pooled, and needs only the product lock the own path takes.
  const outcome = await prisma.$transaction(async (tx) => {
    const location = await tx.stockLocation.findUnique({ where: { id: args.locationId }, select: { type: true } })
    if (location?.type === 'WAREHOUSE') await tx.$executeRaw`SELECT nexus_lock_order_stock(${[args.productId]}::text[])`
    return reserveOpenOrderInTx(tx, args)
  }, { isolationLevel: 'ReadCommitted', maxWait: 5_000, timeout: 30_000 })
  await afterOrderHoldsCommit(outcome.after)
  if (outcome.via === 'refused') throw new Error(`reserveOpenOrder: ${outcome.refusal.error}`)
  return { id: outcome.reservationId, quantity: outcome.quantity }
}

/**
 * Hold identity — an order's hold for a product stays on the side it was first made. Door 2 answers
 * "not pooled" before it looks for the order's hold, and the own path never asked the pool: a re-read
 * across a switch (a grant paused or ended, a product that started selling from a pool) held the
 * order twice, and shipping took it from both. An open or taken own hold keeps the order on its own
 * stock (the R1 guards answer there); an open or taken pool hold keeps it in the pool, even when the
 * product no longer sells from it. A hold that was given back pins nothing, on either side (review
 * C6): then the pool is asked (door 2, which holds once per order and product, ever, while the
 * product still sells from the pool; once it does not, the order is held on its own shelf).
 */
async function heldSide(db: Prisma.TransactionClient | typeof prisma, args: { orderId: string; productId: string }): Promise<{ via: 'own' } | { via: 'ask' } | { via: 'pool'; hold: { id: string; quantity: number } }> {
  const own = await db.stockReservation.count({ where: { orderId: args.orderId, releasedAt: null, stockLevel: { productId: args.productId } } })
  if (own > 0) return { via: 'own' }
  // A product never linked to a pool cannot sell from one, nor have a pool hold (links are this
  // business's rows): its own stock, without asking the pool door at all.
  if (!(await db.stockPoolLink.findFirst({ where: { productId: args.productId }, select: { id: true } }))) return { via: 'own' }
  const pooled = await poolOrderHold(db, { orderRef: args.orderId, productId: args.productId })
  return pooled && pooled.state !== 'released' ? { via: 'pool', hold: { id: pooled.reservationId, quantity: pooled.quantity } } : { via: 'ask' }
}

/**
 * reserveOpenOrder's own-ledger half, inside a transaction the caller owns: one open hold per
 * (order, product). Shared by the wrapper above and by `reserveOpenOrderInTx` without a line key.
 */
async function reserveOwnOpenOrderInTx(tx: Prisma.TransactionClient, args: {
  orderId: string
  productId: string
  variationId?: string
  locationId: string
  quantity: number
  actor?: string
  sale?: SaleRoute
}) {
  // AE.1 — the "already reserved?" check runs under the same lock as the reservation.
  // Checked outside it, a webhook and a poll for one order both found nothing and both
  // reserved (measured: two reservations for one order).
  await lockProductStock(tx, [args.productId])
  const line = { orderId: args.orderId, stockLevel: { productId: args.productId, variationId: args.variationId ?? null } }
  const existing = await tx.stockReservation.findFirst({
    where: { ...line, releasedAt: null, consumedAt: null },
    select: { id: true, quantity: true },
  })
  if (existing) return { reservation: existing, reused: true }

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
  if (took.length > 0 && owed <= 0) return { reservation: took[0], reused: true }

  // Step 2 — "Sells from": a new hold goes to the first location of the sale's list with enough available for
  // what is owed (never split; none has enough → the first, which reports the shortfall as before). Picked here,
  // under the lock, so a concurrent order's hold is seen. No answer (pooled, nothing routed): the caller's location.
  const picked = args.sale ? await saleLocationInTx(tx, { ...args.sale, productId: args.productId, quantity: owed }) : null

  return {
    reservation: await reserveStockInTx(tx, {
      productId: args.productId,
      variationId: args.variationId,
      locationId: picked?.locationId ?? args.locationId,
      quantity: owed,
      orderId: args.orderId,
      reason: 'OPEN_ORDER',
      ttlMs: OPEN_ORDER_TTL_MS,
      actor: args.actor,
    }),
    reused: false,
  }
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
  // And what the order took of it from shared stock (review B1): a product taken from both ledgers is
  // taken at most ordered once. Asked only for a product that was ever linked to a pool.
  const pooled = (await tx.stockPoolLink.findFirst({ where: { productId }, select: { id: true } })) ? await poolOrderTaken(tx, { orderRef: orderId, productId }) : 0
  const taken = (took._sum.quantity ?? 0) + pooled
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
  let consumed = 0
  // Shared stock step 4 — the order's holds in a pool first (door 4a finds only this order's own), so
  // the own-stock cap below counts what the pool already took (review B1).
  try {
    consumed += await consumePoolHolds({ orderId: args.orderId, actor: args.actor })
  } catch {
    // best-effort, like the own holds below; the reconcile job retries.
  }
  const open = await prisma.stockReservation.findMany({
    where: {
      orderId: args.orderId,
      releasedAt: null,
      consumedAt: null,
    },
    select: { id: true },
  })
  for (const r of open) {
    try {
      const settled = await consumeReservation(r.id, { actor: args.actor, capToOrder: true })
      if (settled.consumedAt) consumed++
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
  // Shared stock step 4 — and the order's holds in a pool (door 3 finds only this order's own).
  try {
    released += await releasePoolHolds({ orderId: args.orderId, actor: args.actor, reason: args.reason ?? 'order cancelled' })
  } catch {
    // best-effort, like the own holds above; the reconcile job retries.
  }
  return released
}

// ── An order's units given back, and taken at ingest (R2: one owner for order stock) ─────────────

/**
 * An order's units taken at ingest in their own transaction, lot-aware (FEFO): the mock order ingestion.
 * Partial lot coverage does not block the order — the remainder is taken as non-lot stock with a notes
 * prefix the stock report can split out (allowShortfall). The ORDER_PLACED movement carries the order.
 */
export async function takeOrderUnitsWithLots(args: { orderId: string; productId: string; quantity: number; actor: string; notes?: string }) {
  const { consumeWithFefo } = await import('./lot.service.js')
  return await consumeWithFefo({
    productId: args.productId, quantity: args.quantity, reason: 'ORDER_PLACED', referenceType: 'Order', referenceId: args.orderId,
    orderId: args.orderId, actor: args.actor, ...(args.notes ? { notes: args.notes } : {}), allowShortfall: true,
  })
}

/**
 * An order's units taken at ingest (the eBay writer: a sale is taken when it is recorded), inside the
 * caller's transaction. The ORDER_PLACED movement carries the order: it is the durable evidence E3
 * gives back from if the order is cancelled before it ships. Throws InsufficientStockError (nothing
 * written) when stock is short, and the location/pool refusals of applyStockMovementInTx.
 */
export async function takeOrderUnitsInTx(tx: Prisma.TransactionClient, args: { orderId: string; productId: string; quantity: number; actor: string; notes?: string; locationId?: string | null }): Promise<StockMovementTxResult> {
  return await applyStockMovementInTx(tx, {
    productId: args.productId, change: -args.quantity, reason: 'ORDER_PLACED', referenceType: 'ORDER', referenceId: args.orderId,
    // Step 2 — the location "Sells from" picked (saleLocationInTx); none = the default location, as before.
    ...(args.locationId ? { locationId: args.locationId } : {}),
    orderId: args.orderId, actor: args.actor, ...(args.notes ? { notes: args.notes } : {}),
  })
}

type LedgerDb = Pick<Prisma.TransactionClient, 'stockMovement' | 'return'>
interface TakingMovement { id: string; productId: string; locationId: string | null; change: number }
interface GivenBack { productId: string; change: number; referenceType: string | null; referenceId: string | null; reason?: string }
export interface OwnRestoreStep { movementId: string; productId: string; locationId: string | null; units: number }

/** Pure. What is still owed, per taking movement, oldest first; capped by the product's net. */
export function planOwnRestore(taken: TakingMovement[], givenBack: GivenBack[]): OwnRestoreStep[] {
  const marked = new Set(givenBack.filter(row => row.referenceType === 'StockMovement' && row.referenceId).map(row => row.referenceId!))
  const owed = new Map<string, number>()
  for (const row of taken) owed.set(row.productId, (owed.get(row.productId) ?? 0) - row.change)
  for (const row of givenBack) owed.set(row.productId, (owed.get(row.productId) ?? 0) - row.change)
  const steps: OwnRestoreStep[] = []
  for (const row of taken) {
    if (marked.has(row.id)) continue
    const units = Math.min(-row.change, owed.get(row.productId) ?? 0)
    if (units <= 0) continue
    steps.push({ movementId: row.id, productId: row.productId, locationId: row.locationId, units })
    owed.set(row.productId, (owed.get(row.productId) ?? 0) - units)
  }
  return steps
}

async function ownLedgerOf(db: LedgerDb, orderId: string, productId?: string) {
  const product = productId ? { productId } : {}
  // R4 — only units taken at ingest can come back; a consumed hold's units shipped.
  const taken = await db.stockMovement.findMany({
    where: { orderId, reason: 'ORDER_PLACED', change: { lt: 0 }, ...product },
    select: { id: true, productId: true, locationId: true, change: true }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
  })
  if (!taken.length) return { taken, givenBack: [] as GivenBack[] }
  const returns = await db.return.findMany({ where: { orderId }, select: { id: true } })
  const givenBack: GivenBack[] = [
    ...await db.stockMovement.findMany({ where: { orderId, reason: 'ORDER_CANCELLED', change: { gt: 0 }, ...product },
      select: { productId: true, change: true, referenceType: true, referenceId: true, reason: true } }),
    ...(returns.length ? await db.stockMovement.findMany({ where: { reason: 'RETURN_RESTOCKED', referenceType: 'Return', referenceId: { in: returns.map(row => row.id) }, change: { gt: 0 }, ...product },
      select: { productId: true, change: true, referenceType: true, referenceId: true } }) : []),
  ]
  return { taken, givenBack }
}

/**
 * C1 — the restore plan after a partial shipment: per product, at most the units taken that did not
 * ship (taken − shipped − already given back by a cancellation); none for a product the channel does
 * not describe. A return's restock does not count here: it gives back units that shipped.
 */
function planAfterShipment(ledger: { taken: TakingMovement[]; givenBack: GivenBack[] }, shipped: ShippedUnits | null): OwnRestoreStep[] {
  const steps = planOwnRestore(ledger.taken, ledger.givenBack)
  if (!shipped) return steps
  const room = new Map<string, number>()
  for (const productId of new Set(ledger.taken.map((row) => row.productId))) {
    if (shipped.unknown.has(productId) || !shipped.known.has(productId)) { room.set(productId, 0); continue }
    const taken = ledger.taken.filter((row) => row.productId === productId).reduce((sum, row) => sum - row.change, 0)
    const cancelled = ledger.givenBack.filter((row) => row.productId === productId && row.reason === 'ORDER_CANCELLED').reduce((sum, row) => sum + row.change, 0)
    room.set(productId, Math.max(0, taken - shipped.known.get(productId)! - cancelled))
  }
  const out: OwnRestoreStep[] = []
  for (const step of steps) {
    const units = Math.min(step.units, room.get(step.productId) ?? 0)
    if (units <= 0) continue
    out.push({ ...step, units })
    room.set(step.productId, (room.get(step.productId) ?? 0) - units)
  }
  return out
}

/** True while the order's own ledger still owes units back: a failed or interrupted restore. */
export async function ownRestorePending(db: LedgerDb, orderId: string, shipped: ShippedUnits | null = null): Promise<boolean> {
  const ledger = await ownLedgerOf(db, orderId)
  return planAfterShipment(ledger, shipped).length > 0
}

/**
 * Gives back what the order still owes, one product per transaction under the stock lock (a
 * concurrent cancellation of the same order waits, then finds the markers and gives back nothing).
 */
export async function giveBackOrderTakes(orderId: string, actor: string, shipped: ShippedUnits | null = null): Promise<{ restored: number; units: number; errors: Array<{ itemId: string; error: string }> }> {
  const products = [...new Set((await ownLedgerOf(prisma, orderId)).taken.map(row => row.productId))].sort()
  const out = { restored: 0, units: 0, errors: [] as Array<{ itemId: string; error: string }> }
  for (const productId of products) {
    try {
      const committed = await prisma.$transaction(async tx => {
        await lockProductStock(tx, [productId])
        // Read after the lock: whatever a concurrent restore committed is visible now.
        const ledger = await ownLedgerOf(tx, orderId, productId)
        const results: StockMovementTxResult[] = []
        for (const step of planAfterShipment(ledger, shipped)) {
          results.push(await applyStockMovementInTx(tx, {
            productId, ...(step.locationId ? { locationId: step.locationId } : {}), change: step.units, reason: 'ORDER_CANCELLED',
            referenceType: 'StockMovement', referenceId: step.movementId, orderId, actor,
            notes: `Order ${orderId} cancelled: gives back movement ${step.movementId}`,
          }))
        }
        return results
      }, { isolationLevel: 'ReadCommitted', maxWait: 5_000, timeout: 30_000 })
      for (const result of committed) {
        try { await afterStockMovementCommit({ productId, reason: 'ORDER_CANCELLED' }, result) } catch { /* the drain cron is the backstop */ }
        out.units += result.movement.change
      }
      out.restored += committed.length
    } catch (err) {
      out.errors.push({ itemId: productId, error: `Restock ${productId}: ${err instanceof Error ? err.message : String(err)}` })
    }
  }
  return out
}

// ── An order's holds inside a transaction the CALLER owns (Etsy's single-transaction writer) ─────
//
// The functions above each open their own transaction (consume/release one per reservation, with
// failures swallowed), so an order writer cannot make its order row, its lines and its stock one
// atomic change. These run entirely on the caller's `tx`, with the SAME rules as the wrappers (R1
// guards, hold identity, the consume cap): nothing is committed, published or queued unless the
// caller commits, and the work that must follow a commit is RETURNED (`after`) for
// `afterOrderHoldsCommit`. One hold per (order, product), sized to the product's units over all of
// the order's lines (R10); the order and its products are locked by the caller first
// (nexus_lock_order_stock), so two writers of one order, or of orders with lines in opposite
// orders, run one after the other and cannot deadlock.

/** Post-commit work the in-transaction functions hand back. Run it ONLY after the caller commits. */
export interface OrderHoldsAfterCommit {
  /** Movements that changed quantity: `afterStockMovementCommit` for each (push, stockout hook, cache). */
  committed: StockMovementTxResult[]
  /** A pool door changed shared stock: kick the pool worker (the lender's bookkeeping). */
  poolChanged: boolean
  /** A pool door refused: the owners are told — never for an attempt that rolled back. */
  refusals: Array<{ orderId: string; productId: string; quantity: number; what: string; refusal: PoolRefusal }>
}

export const nothingAfter = (): OrderHoldsAfterCommit => ({ committed: [], poolChanged: false, refusals: [] })

/** Merge `more` into `into` (the post-commit work of several in-transaction calls). */
export function addAfter(into: OrderHoldsAfterCommit, more: OrderHoldsAfterCommit): OrderHoldsAfterCommit {
  into.committed.push(...more.committed)
  into.poolChanged ||= more.poolChanged
  into.refusals.push(...more.refusals)
  return into
}

export type OrderHoldInTx =
  | { via: 'own' | 'pool'; reservationId: string; quantity: number; reused: boolean; after: OrderHoldsAfterCommit }
  /** Shared stock refused (not enough, the grant ended, …): nothing held; the owners are told after commit. */
  | { via: 'refused'; refusal: PoolRefusal; after: OrderHoldsAfterCommit }

/**
 * reserveOpenOrder inside the caller's transaction: the same routing (hold identity, then door 2 for a
 * warehouse hold of a pooled product) and the same R1 guards. A shortfall of own stock throws
 * InsufficientStockError and a missing stock level StockLevelMissingError, BEFORE anything is written
 * (the caller's transaction stays usable and may record the line's disposition).
 */
export async function reserveOpenOrderInTx(tx: Prisma.TransactionClient, args: {
  orderId: string
  productId: string
  variationId?: string
  /** A warehouse (or, for MCF, the FBA location). With `sale`, the fallback when "Sells from" does not decide. */
  locationId: string
  quantity: number
  actor?: string
  /** Step 2 — where the order sold: a new warehouse hold is picked from that market's "Sells from" list. */
  sale?: SaleRoute
}): Promise<OrderHoldInTx> {
  const after = nothingAfter()
  const location = await tx.stockLocation.findUnique({ where: { id: args.locationId }, select: { type: true } })
  if (location?.type === 'WAREHOUSE') {
    const side = await heldSide(tx, args)
    if (side.via === 'pool') return { via: 'pool', reservationId: side.hold.id, quantity: side.hold.quantity, reused: true, after }
    if (side.via === 'ask') {
      const answer = await poolReserve(tx, { productId: args.productId, quantity: args.quantity, orderRef: args.orderId, actor: args.actor ?? 'system' })
      const refusal = refusalOf(answer)
      if (!refusal) {
        const hold = answer as Extract<typeof answer, { ok: true }>
        after.poolChanged = !hold.reused
        return { via: 'pool', reservationId: hold.reservationId, quantity: hold.quantity, reused: hold.reused, after }
      }
      if (refusal.code !== 'not_pooled') {
        after.refusals.push({ orderId: args.orderId, productId: args.productId, quantity: args.quantity, what: 'a hold', refusal })
        return { via: 'refused', refusal, after }
      }
    }
  }
  // Only a warehouse hold follows "Sells from"; an FBA hold (MCF) stays where the caller put it.
  const own = await reserveOwnOpenOrderInTx(tx, { ...args, sale: location?.type === 'WAREHOUSE' ? args.sale : undefined })
  return { via: 'own', reservationId: own.reservation.id, quantity: own.reservation.quantity, reused: own.reused, after }
}

/**
 * consumeOpenOrder inside the caller's transaction: every open own hold of the order, capped to what
 * the order still owes of its product (a surplus is released), then its open pool holds (door 4a).
 * Returns how many holds were taken out.
 */
export async function consumeOpenOrderInTx(tx: Prisma.TransactionClient, args: { orderId: string; actor?: string }): Promise<{ consumed: number; after: OrderHoldsAfterCommit }> {
  const after = nothingAfter()
  // Pool holds first, so the own-stock cap counts what the pool already took (review B1).
  const pool = await poolConsume(tx, { orderRef: args.orderId, actor: args.actor ?? null })
  const refusal = refusalOf(pool)
  if (refusal) throw new Error(`Shared stock could not take out this order's holds: [${refusal.code}] ${refusal.error}`)
  const poolConsumed = (pool as Extract<typeof pool, { ok: true }>).consumed
  after.poolChanged = poolConsumed > 0
  let consumed = poolConsumed
  const open = await tx.stockReservation.findMany({ where: { orderId: args.orderId, releasedAt: null, consumedAt: null }, select: { id: true }, orderBy: { id: 'asc' } })
  for (const r of open) {
    const settled = await consumeReservationInTx(tx, r.id, { actor: args.actor, capToOrder: true })
    after.committed.push(...settled.committed)
    if (settled.consumed.consumedAt) consumed++
  }
  return { consumed, after }
}

/** releaseOpenOrder inside the caller's transaction: every open own hold of the order, then its open pool holds (door 3). */
export async function releaseOpenOrderInTx(tx: Prisma.TransactionClient, args: { orderId: string; actor?: string; reason?: string }): Promise<{ released: number; after: OrderHoldsAfterCommit }> {
  const after = nothingAfter()
  const reason = args.reason ?? 'order cancelled'
  let released = 0
  const open = await tx.stockReservation.findMany({ where: { orderId: args.orderId, releasedAt: null, consumedAt: null }, select: { id: true }, orderBy: { id: 'asc' } })
  for (const r of open) {
    await releaseReservationInTx(tx, r.id, { actor: args.actor, reason })
    released++
  }
  const pool = await poolRelease(tx, { orderRef: args.orderId, actor: args.actor ?? null, reason })
  const refusal = refusalOf(pool)
  if (refusal) throw new Error(`Shared stock could not give back this order's holds: [${refusal.code}] ${refusal.error}`)
  const poolReleased = (pool as Extract<typeof pool, { ok: true }>).released
  after.poolChanged = poolReleased > 0
  return { released: released + poolReleased, after }
}

/**
 * C1 — what the channel says shipped of an order, per product, line by line (Amazon QuantityShipped,
 * Etsy per-line shipped time, eBay line fulfilment status, Shopify fulfilments). A product with any
 * line the channel does not describe is `unknown`: nothing about it may be released into stock.
 */
export interface ShippedUnits {
  known: Map<string, number>
  unknown: Set<string>
}

export interface SettledOrderHolds {
  /** Holds given back whole. */
  released: number
  /** Holds taken out (whole, or the shipped part of a split). */
  consumed: number
  /** Units given back to stock (whole holds and the unshipped part of split ones). */
  releasedUnits: number
  /** Units taken out because they shipped. */
  takenUnits: number
  /** Holds kept open: the channel does not say whether their units shipped. */
  kept: Array<{ productId: string; quantity: number; side: 'own' | 'pool' }>
  /** Per product: units taken and given back here, for a writer that reports per line. */
  products: Map<string, { taken: number; released: number; kept: number }>
  after: OrderHoldsAfterCommit
}

/**
 * The holds of a cancelled (or wholly refunded) order, inside the caller's transaction; the caller has
 * locked the order's products (nexus_lock_order_stock). `shipped` null: nothing shipped — every open
 * hold is given back. Otherwise (C1, a cancellation after a partial shipment) per product: the units
 * the channel says shipped are taken out (capped to what the order still owes; own holds split, pool
 * holds taken then the rest put back through door 5 once), the rest given back; a product the channel
 * does not describe keeps its hold — never released into stock (Owner ruling R4, 2026-09-26). Idempotent:
 * a settled hold is not open any more, and a kept hold is kept again.
 */
export async function settleOrderHoldsInTx(tx: Prisma.TransactionClient, args: { orderId: string; actor?: string; reason?: string; shipped: ShippedUnits | null }): Promise<SettledOrderHolds> {
  const after = nothingAfter()
  const out: SettledOrderHolds = { released: 0, consumed: 0, releasedUnits: 0, takenUnits: 0, kept: [], products: new Map(), after }
  const reason = args.reason ?? 'order cancelled'
  const note = (productId: string, change: Partial<{ taken: number; released: number; kept: number }>) => {
    const row = out.products.get(productId) ?? { taken: 0, released: 0, kept: 0 }
    out.products.set(productId, { taken: row.taken + (change.taken ?? 0), released: row.released + (change.released ?? 0), kept: row.kept + (change.kept ?? 0) })
  }
  if (!args.shipped) {
    // Nothing shipped: every open hold is given back — own ones, and all of the order's pool holds
    // (door 3 finds them by the order, whether or not a line still names their product).
    const open = await tx.stockReservation.findMany({ where: { orderId: args.orderId, releasedAt: null, consumedAt: null },
      select: { id: true, quantity: true, stockLevel: { select: { productId: true } } }, orderBy: { id: 'asc' } })
    for (const r of open) {
      await releaseReservationInTx(tx, r.id, { actor: args.actor, reason })
      out.released++
      out.releasedUnits += r.quantity
      note(r.stockLevel.productId, { released: r.quantity })
    }
    const pool = await poolRelease(tx, { orderRef: args.orderId, actor: args.actor ?? null, reason })
    const refusal = refusalOf(pool)
    if (refusal) throw new Error(`Shared stock could not give back this order's holds: [${refusal.code}] ${refusal.error}`)
    const given = pool as Extract<typeof pool, { ok: true }>
    after.poolChanged = given.released > 0
    out.released += given.released
    out.releasedUnits += given.units
    return out
  }
  const shippedOf = (productId: string): number | null => {
    if (!args.shipped) return 0
    if (args.shipped.unknown.has(productId) || !args.shipped.known.has(productId)) return null
    return args.shipped.known.get(productId)!
  }
  // Units of a product still to take because they shipped, counted once per product under the lock.
  const toTake = new Map<string, number>()
  const stillToTake = async (productId: string, shipped: number) => {
    if (!toTake.has(productId)) {
      const due = await owedToOrder(tx, args.orderId, productId)
      toTake.set(productId, Math.max(0, Math.min(shipped, due.ordered ?? shipped) - due.taken))
    }
    return toTake.get(productId)!
  }

  const open = await tx.stockReservation.findMany({ where: { orderId: args.orderId, releasedAt: null, consumedAt: null },
    select: { id: true, quantity: true, stockLevel: { select: { productId: true } } }, orderBy: { id: 'asc' } })
  for (const r of open) {
    const productId = r.stockLevel.productId
    const shipped = shippedOf(productId)
    if (shipped === null) {
      out.kept.push({ productId, quantity: r.quantity, side: 'own' })
      note(productId, { kept: r.quantity })
      continue
    }
    const take = Math.min(r.quantity, await stillToTake(productId, shipped))
    if (take === 0) {
      await releaseReservationInTx(tx, r.id, { actor: args.actor, reason })
      out.released++
      out.releasedUnits += r.quantity
      note(productId, { released: r.quantity })
      continue
    }
    const settled = await consumeReservationInTx(tx, r.id, { actor: args.actor, capToOrder: true, takeAtMost: take, reason })
    after.committed.push(...settled.committed)
    const took = settled.consumed.consumedAt ? settled.consumed.quantity : 0
    toTake.set(productId, toTake.get(productId)! - took)
    if (took > 0) out.consumed++
    else out.released++
    out.takenUnits += took
    out.releasedUnits += r.quantity - took
    note(productId, { taken: took, released: r.quantity - took })
  }

  // Shared stock: the order's open pool hold per product (one per order and product), through the doors.
  const lines = await tx.orderItem.findMany({ where: { orderId: args.orderId, productId: { not: null } }, select: { productId: true } })
  const products = [...new Set(lines.map((line) => line.productId!))].sort()
  const everLinked = products.length > 0 && (await tx.stockPoolLink.findFirst({ where: { productId: { in: products } }, select: { id: true } })) !== null
  for (const productId of everLinked ? products : []) {
    const hold = await poolOrderHold(tx, { orderRef: args.orderId, productId })
    if (!hold || hold.state !== 'open') continue
    const shipped = shippedOf(productId)
    if (shipped === null) {
      out.kept.push({ productId, quantity: hold.quantity, side: 'pool' })
      note(productId, { kept: hold.quantity })
      continue
    }
    const take = Math.min(hold.quantity, await stillToTake(productId, shipped))
    if (take === 0) {
      const given = await poolRelease(tx, { orderRef: args.orderId, productId, actor: args.actor ?? null, reason })
      const refusal = refusalOf(given)
      if (refusal) throw new Error(`Shared stock could not give back this order's hold: [${refusal.code}] ${refusal.error}`)
      after.poolChanged = true
      out.released++
      out.releasedUnits += hold.quantity
      note(productId, { released: hold.quantity })
      continue
    }
    // Door 4a takes a pool hold whole; the unshipped rest goes back through door 5, once per order.
    const taken = await poolConsume(tx, { orderRef: args.orderId, productId, actor: args.actor ?? null })
    const takeRefusal = refusalOf(taken)
    if (takeRefusal) throw new Error(`Shared stock could not take out this order's hold: [${takeRefusal.code}] ${takeRefusal.error}`)
    after.poolChanged = true
    out.consumed++
    const back = hold.quantity - take
    if (back > 0) {
      const put = await poolPutBack(tx, { productId, quantity: back, orderRef: args.orderId, putBackRef: args.orderId, reason: 'ORDER_CANCELLED', actor: args.actor ?? null })
      const putRefusal = refusalOf(put)
      if (putRefusal) throw new Error(`Shared stock could not put back the unshipped units of this order: [${putRefusal.code}] ${putRefusal.error}`)
    }
    out.takenUnits += take
    out.releasedUnits += back
    note(productId, { taken: take, released: back })
  }
  return out
}

/**
 * Re-review (2026-09-26) — part of an order shipped and the rest has not (a partial fulfilment): take
 * out, per product, the units that shipped and keep the rest held. Capped to what the order still owes
 * (R1), so a re-read of the same fulfilment takes nothing more. Own holds are split (takeFromHoldInTx);
 * a pool hold is taken whole by door 4a, so it is taken once all of its product's units shipped (until
 * then it stays held, and a cancellation settles it by what shipped). The caller has locked the order's
 * products (nexus_lock_order_stock with the order reference).
 */
export async function takeShippedUnitsInTx(tx: Prisma.TransactionClient, args: { orderId: string; shipped: Map<string, number>; actor?: string }): Promise<{ taken: number; after: OrderHoldsAfterCommit }> {
  const after = nothingAfter()
  let taken = 0
  for (const productId of [...args.shipped.keys()].sort()) {
    const units = args.shipped.get(productId)!
    if (!(units > 0)) continue
    const due = await owedToOrder(tx, args.orderId, productId)
    let toTake = Math.max(0, Math.min(units, due.ordered ?? units) - due.taken)
    const open = toTake > 0 ? await tx.stockReservation.findMany({ where: { orderId: args.orderId, releasedAt: null, consumedAt: null, stockLevel: { productId } },
      select: { id: true, quantity: true }, orderBy: { id: 'asc' } }) : []
    for (const hold of open) {
      if (toTake <= 0) break
      const settled = await takeFromHoldInTx(tx, hold.id, Math.min(toTake, hold.quantity), { actor: args.actor })
      after.committed.push(...settled.committed)
      toTake -= settled.took
      taken += settled.took
    }
    // Shared stock: its hold is taken whole, once every unit of the product shipped.
    if (due.ordered !== null && units >= due.ordered && (await tx.stockPoolLink.findFirst({ where: { productId }, select: { id: true } }))) {
      const pooled = await poolOrderHold(tx, { orderRef: args.orderId, productId })
      if (pooled?.state === 'open') {
        const out = await poolConsume(tx, { orderRef: args.orderId, productId, actor: args.actor ?? null })
        const refusal = refusalOf(out)
        if (refusal) throw new Error(`Shared stock could not take out this order's hold: [${refusal.code}] ${refusal.error}`)
        after.poolChanged ||= (out as Extract<typeof out, { ok: true }>).consumed > 0
        taken += (out as Extract<typeof out, { ok: true }>).units
      }
    }
  }
  return { taken, after }
}

/**
 * Take `units` out of one open own hold. The whole hold: consumeReservation's work (capped). Part of it:
 * the hold is split on the same level — a continuing hold keeps the rest (its creation is audited),
 * the original is narrowed to `units` and taken out, so `reserved` falls only by what left.
 */
async function takeFromHoldInTx(tx: Prisma.TransactionClient, reservationId: string, units: number, opts: { actor?: string }): Promise<{ took: number; committed: StockMovementTxResult[] }> {
  const target = await tx.stockReservation.findUnique({ where: { id: reservationId }, select: { stockLevel: { select: { productId: true } } } })
  if (!target) return { took: 0, committed: [] }
  await lockProductStock(tx, [target.stockLevel.productId])
  const r = await tx.stockReservation.findUnique({ where: { id: reservationId }, include: { stockLevel: true } })
  if (!r || r.releasedAt || r.consumedAt || !(units > 0) || r.consumerWorkspaceId) return { took: 0, committed: [] }
  if (units < r.quantity) {
    const rest = await tx.stockReservation.create({ data: {
      stockLevelId: r.stockLevelId, quantity: r.quantity - units, orderId: r.orderId, reason: r.reason, kind: r.kind, expiresAt: r.expiresAt,
    } })
    await tx.stockReservation.update({ where: { id: r.id }, data: { quantity: units } })
    await tx.stockMovement.create({ data: {
      productId: r.stockLevel.productId, variationId: r.stockLevel.variationId, locationId: r.stockLevel.locationId,
      change: 0, balanceAfter: r.stockLevel.quantity, quantityBefore: r.stockLevel.quantity, reason: 'RESERVATION_CREATED',
      referenceType: 'StockReservation', referenceId: rest.id, orderId: r.orderId, reservationId: rest.id,
      notes: `Continues hold ${r.id}: ${units} of its ${r.quantity} units shipped; the other ${r.quantity - units} stay held`, actor: opts.actor ?? null,
    } })
  }
  const settled = await consumeReservationInTx(tx, r.id, { actor: opts.actor, capToOrder: true })
  return { took: settled.consumed.consumedAt ? settled.consumed.quantity : 0, committed: settled.committed }
}

/** The work the in-transaction functions handed back. Call it once, after the caller committed. */
export async function afterOrderHoldsCommit(after: OrderHoldsAfterCommit): Promise<void> {
  for (const committed of after.committed) {
    await afterStockMovementCommit({ productId: committed.movement.productId, reason: committed.movement.reason }, committed)
  }
  if (after.poolChanged) afterPoolChange()
  for (const refused of after.refusals) await reportPoolOrderRefusal(refused)
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
