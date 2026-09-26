import type { Prisma } from '@prisma/client'
import prisma from '../../db.js'
import { logger } from '../../utils/logger.js'
import { poolConsume, poolPutBack, poolRelease, poolReserve, poolTake, refusalOf, type PoolRefusal } from './pool-doors.js'
import { afterPoolChange } from './pool-tasks.js'
import { notifyOwners, notifyOwnersInTx, type PoolNotice } from './pool-notify.js'

/**
 * Shared stock plan step 4 — orders, cancellations and returns through the doors (plan
 * docs/2026-09-19-shared-stock-plan.md §6–7, contract docs/2026-09-19-shared-stock-build.md §4).
 *
 * THE RULE. Where an order line's stock comes from is decided once, when the sale or the hold is
 * made, and everything that follows goes back to that same place:
 *   • a NEW sale or hold uses the pool when the product sells from one right now (the door decides:
 *     `not_pooled` means own stock), else the business's own ledger;
 *   • giving back, taking out and putting back follow the ORDER, not today's switch: the pool doors
 *     find only this order's pool holds and takes, the own-ledger functions only its own ones, so
 *     both are asked and each settles what is its own (D-6: orders already made never get stranded).
 * A door's refusal is an answer: `insufficient` is an oversell — nothing is taken, the owners are
 * told (bell), and the caller logs it as it logs an own-stock oversell today.
 */

export type RouteResult<T> =
  | { via: 'pool'; result: T }
  | { via: 'own' }
  | { via: 'refused'; refusal: PoolRefusal }

/** A door that throws (the database, the network) is an UNKNOWN outcome: it may have committed. The
 *  owners are told to check the order; the door is idempotent per order, so a retry is safe. */
function failure(error: unknown): PoolRefusal {
  return { error: `Shared stock could not be reached: ${error instanceof Error ? error.message : String(error)}.`, code: 'door_failed', status: 503 }
}

/**
 * A door threw. For a product that never sold from a pool the door would have answered `not_pooled`,
 * so it keeps its own-stock path exactly as before this work — a business that does not use shared
 * stock is never told about it and never loses a deduction to it. Anything else (a pooled product, or
 * a check that fails too) stays an unknown outcome.
 */
async function ownIfNeverPooled(productId: string, error: unknown): Promise<PoolRefusal | null> {
  try {
    const link = await prisma.stockPoolLink.findFirst({ where: { productId }, select: { id: true } })
    if (!link) return null
  } catch { /* unknown: keep the failure */ }
  return failure(error)
}

type RefusedArgs = { orderId: string; productId: string; quantity: number; what: string; refusal: PoolRefusal }

function refusalNotice(args: RefusedArgs, sku: string): PoolNotice {
  return {
    type: 'stock-pool-order-refused',
    severity: 'danger',
    title: `Shared stock refused ${args.what} of ${args.quantity} × ${sku}`,
    body: args.refusal.code === 'door_failed'
      ? `${args.refusal.error} It may or may not have been taken. Check the order and the stock.`
      : `${args.refusal.error} Nothing was taken from shared stock or from your own stock. Check the order.`,
    entityType: 'Order',
    entityId: args.orderId,
    href: `/orders/${args.orderId}`,
    meta: { productId: args.productId, quantity: args.quantity, code: args.refusal.code },
  }
}

async function refused(args: RefusedArgs): Promise<void> {
  const product = await prisma.product.findUnique({ where: { id: args.productId }, select: { sku: true } }).catch(() => null)
  logger.warn('[stock-pool] order refused by shared stock', { orderId: args.orderId, productId: args.productId, quantity: args.quantity, what: args.what, code: args.refusal.code, error: args.refusal.error })
  await notifyOwners(refusalNotice(args, product?.sku ?? args.productId))
}

/** A sale with no hold (eBay, manual ingest): take at once from the pool, or say "own". */
export async function takeForOrder(args: { productId: string; quantity: number; orderId: string; actor: string }): Promise<RouteResult<{ taken: number; reused: boolean }>> {
  let r: Awaited<ReturnType<typeof poolTake>>
  try {
    r = await poolTake(prisma, { productId: args.productId, quantity: args.quantity, orderRef: args.orderId, actor: args.actor })
  } catch (error) {
    const refusal = await ownIfNeverPooled(args.productId, error)
    if (!refusal) return { via: 'own' }
    r = { ok: false, refusal }
  }
  const refusal = refusalOf(r)
  if (refusal) {
    if (refusal.code === 'not_pooled') return { via: 'own' }
    await refused({ ...args, what: 'the sale', refusal })
    return { via: 'refused', refusal }
  }
  const took = r as Extract<typeof r, { ok: true }>
  if (!took.reused) afterPoolChange()
  return { via: 'pool', result: { taken: took.taken, reused: took.reused } }
}

/**
 * `takeForOrder` inside a transaction the caller owns: the take, and a refusal's owner notice, commit
 * or roll back with the order. A door that throws is not an unknown outcome here — it rolls the whole
 * transaction back — so there is no own-stock fallback and no `door_failed` notice. The caller runs
 * `afterPoolChange()` after its commit when `changed` is true.
 */
export async function takeForOrderInTx(tx: Prisma.TransactionClient, args: { productId: string; quantity: number; orderId: string; actor: string; workspaceId?: string }): Promise<RouteResult<{ taken: number; reused: boolean }> & { changed: boolean }> {
  const r = await poolTake(tx, { productId: args.productId, quantity: args.quantity, orderRef: args.orderId, actor: args.actor })
  const refusal = refusalOf(r)
  if (refusal) {
    if (refusal.code === 'not_pooled') return { via: 'own', changed: false }
    const product = await tx.product.findUnique({ where: { id: args.productId }, select: { sku: true } })
    logger.warn('[stock-pool] order refused by shared stock', { orderId: args.orderId, productId: args.productId, quantity: args.quantity, what: 'the sale', code: refusal.code, error: refusal.error })
    await notifyOwnersInTx(tx, refusalNotice({ ...args, what: 'the sale', refusal }, product?.sku ?? args.productId), args.workspaceId)
    return { via: 'refused', refusal, changed: false }
  }
  const took = r as Extract<typeof r, { ok: true }>
  return { via: 'pool', result: { taken: took.taken, reused: took.reused }, changed: !took.reused }
}

/** A hold for an open order (Amazon FBM, Shopify): from the pool, or say "own". */
export async function holdForOrder(args: { productId: string; quantity: number; orderId: string; actor: string }): Promise<RouteResult<{ reservationId: string; quantity: number; state: string; reused: boolean }>> {
  let r: Awaited<ReturnType<typeof poolReserve>>
  try {
    r = await poolReserve(prisma, { productId: args.productId, quantity: args.quantity, orderRef: args.orderId, actor: args.actor })
  } catch (error) {
    const refusal = await ownIfNeverPooled(args.productId, error)
    if (!refusal) return { via: 'own' }
    r = { ok: false, refusal }
  }
  const refusal = refusalOf(r)
  if (refusal) {
    if (refusal.code === 'not_pooled') return { via: 'own' }
    await refused({ ...args, what: 'a hold', refusal })
    return { via: 'refused', refusal }
  }
  const hold = r as Extract<typeof r, { ok: true }>
  if (!hold.reused) afterPoolChange()
  return { via: 'pool', result: { reservationId: hold.reservationId, quantity: hold.quantity, state: hold.state, reused: hold.reused } }
}

/** Give back every pool hold of an order (cancelled). Returns how many holds were given back. */
export async function releasePoolHolds(args: { orderId: string; actor?: string; reason?: string }): Promise<number> {
  const r = await poolRelease(prisma, { orderRef: args.orderId, actor: args.actor ?? null, reason: args.reason ?? null })
  const refusal = refusalOf(r)
  if (refusal) {
    logger.warn('[stock-pool] give back refused', { orderId: args.orderId, code: refusal.code, error: refusal.error })
    return 0
  }
  const { released } = r as Extract<typeof r, { ok: true }>
  if (released > 0) afterPoolChange()
  return released
}

/** Take out every pool hold of an order (shipped). Returns how many holds were taken out. */
export async function consumePoolHolds(args: { orderId: string; actor?: string }): Promise<number> {
  const r = await poolConsume(prisma, { orderRef: args.orderId, actor: args.actor ?? null })
  const refusal = refusalOf(r)
  if (refusal) {
    logger.warn('[stock-pool] take out refused', { orderId: args.orderId, code: refusal.code, error: refusal.error })
    return 0
  }
  const { consumed } = r as Extract<typeof r, { ok: true }>
  if (consumed > 0) afterPoolChange()
  return consumed
}

/** For callers that hold inside their own transaction: the same owner notice, sent after their commit. */
export { refused as reportPoolOrderRefusal }

export type PutBackRoute =
  | { via: 'pool'; reused: boolean }
  /** The order did not take this product from the pool: its own ledger decides. */
  | { via: 'own' }
  /** The order took it from the pool, and as many units as it took are back already. */
  | { via: 'none'; refusal: PoolRefusal }

/**
 * Units of an order come back: a sale that was already taken is cancelled (`ORDER_CANCELLED`,
 * `putBackRef` = the order) or a return is put back on the shelf (`RETURN_RESTOCKED`, `putBackRef` =
 * the return). To the pool when the order took them from the pool (capped at what it took), else own.
 */
export async function putBackForOrder(args: {
  productId: string
  quantity: number
  orderId: string
  putBackRef: string
  reason: 'ORDER_CANCELLED' | 'RETURN_RESTOCKED'
  actor: string
}): Promise<PutBackRoute> {
  let r: Awaited<ReturnType<typeof poolPutBack>>
  try {
    r = await poolPutBack(prisma, { productId: args.productId, quantity: args.quantity, orderRef: args.orderId, putBackRef: args.putBackRef, reason: args.reason, actor: args.actor })
  } catch (error) {
    const refusal = await ownIfNeverPooled(args.productId, error)
    if (!refusal) return { via: 'own' }
    throw error // a pooled product: the caller reports the failure; the put back is idempotent, so a retry is safe
  }
  const refusal = refusalOf(r)
  if (refusal) {
    if (refusal.code === 'not_from_pool') return { via: 'own' }
    logger.warn('[stock-pool] put back refused', { orderId: args.orderId, productId: args.productId, code: refusal.code, error: refusal.error })
    return { via: 'none', refusal }
  }
  const { reused } = r as Extract<typeof r, { ok: true }>
  if (!reused) afterPoolChange()
  return { via: 'pool', reused }
}
