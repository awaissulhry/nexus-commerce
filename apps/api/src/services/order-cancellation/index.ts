/**
 * O.45 — Order cancellation cascade.
 *
 * When a channel reports an order as CANCELLED (via the ingest cron or
 * a webhook), the system today did nothing about associated shipments:
 * a label could be printed, the parcel sitting at Sendcloud, with the
 * customer expecting a refund + the operator unaware. This service
 * runs the cleanup chain:
 *
 *   1. Find active (non-CANCELLED, non-DELIVERED) shipments for the
 *      order.
 *   2. For each:
 *      - If it has a Sendcloud parcel id, void via the Sendcloud API
 *        (best-effort — Sendcloud refuses post-pickup, which is fine;
 *        we record the failure but proceed).
 *      - Transition Shipment.status to CANCELLED + cancelledAt = now.
 *      - Append AuditLog row.
 *      - Publish 'shipment.deleted' SSE event so open browsers
 *        refresh.
 *
 * Idempotent — running it twice on the same order is a no-op the
 * second time. Safe to call from ingest cron paths that re-process
 * the same order.
 *
 * Skips DELIVERED + already-CANCELLED shipments. If a shipment is
 * already SHIPPED / IN_TRANSIT, we still cancel-on-our-side (so the
 * UI reflects reality) but we DON'T attempt to void at Sendcloud
 * since the carrier has it.
 */

import type { Prisma } from '@prisma/client'
import prisma from '../../db.js'
// R2 — the stock writes of a cancellation (holds released, units given back) live in the stock service.
import {
  afterOrderHoldsCommit, giveBackOrderTakes, ownRestorePending, planOwnRestore, settleOrderHoldsInTx,
  type OwnRestoreStep, type SettledOrderHolds, type ShippedUnits,
} from '../stock-level.service.js'
export { ownRestorePending, planOwnRestore, type OwnRestoreStep, type ShippedUnits }

export interface CancellationCleanupResult {
  orderId: string
  shipmentsScanned: number
  shipmentsCancelled: number
  parcelsVoided: number
  parcelsVoidFailed: number
  itemsRestocked: number
  // S.2 — reservations released for orders that used the
  // reserve-then-consume pattern (Amazon FBM today; Shopify in S.2.5).
  reservationsReleased: number
  /** R4 — (part of) the order had shipped: nothing that shipped was given back, and the owners were told. */
  shippedBeforeCancel: boolean
  errors: Array<{ shipmentId?: string; itemId?: string; error: string }>
}

const TERMINAL_STATUSES = ['CANCELLED', 'DELIVERED', 'RETURNED'] as const

/* ────────────────────────────────────────────────────────────────────────────────────
 * E3 — give back exactly what the order took AT INGEST from this business's own shelves, and only
 * while none of the order has shipped (stock model R4, 2026-09-26).
 *
 * The own ledger is the evidence: every unit an order took at ingest is a negative ORDER_PLACED
 * movement (decrement at ingestion: eBay) carrying its orderId, at the location it left. Each
 * restore is an ORDER_CANCELLED movement referencing the taking movement (referenceType
 * 'StockMovement') — the durable marker: a re-run gives back only what is still owed, per taking
 * movement (so per eBay line), and never what a return or an older per-order restore already gave
 * back. A line that took nothing (a shortfall, blocked stock, an order that arrived cancelled, a
 * released hold, an FBA order) has no taking movement and gets nothing. Pool units go back through
 * door 5 as before.
 *
 * R4 — units taken when the order SHIPPED (a consumed hold: RESERVATION_CONSUMED) left the shelf and
 * are never given back automatically: a return restocks them. Nor are units taken at ingest once the
 * order shows that (part of) it shipped. Such a cancellation releases open holds, gives back nothing
 * and tells the owners once (`orderShipmentEvidence`). Before R4 a consumed hold came back too, while
 * the Etsy writer kept shipped units deducted: the two channels disagreed.
 * ──────────────────────────────────────────────────────────────────────────────────── */

type ShipmentDb = Pick<Prisma.TransactionClient, 'order' | 'stockReservation' | 'stockMovement' | 'shipment'>
const PICKED_UP = ['SHIPPED', 'IN_TRANSIT', 'DELIVERED', 'RETURNED'] as const

/**
 * R4 — did (part of) this order leave the shelf? Any one of: the order's shipped or delivered time
 * (every channel writer sets it on its first shipped read, a partial shipment included); a consumed
 * hold of its own or in shared stock (holds are consumed only when an order ships — review B4: a
 * consumed POOL hold is evidence the own ledger cannot show, and door 5 counts it as taken); a parcel
 * past pickup.
 */
export async function orderShipmentEvidence(db: ShipmentDb & Pick<Prisma.TransactionClient, '$queryRaw' | 'stockPoolLink'>, orderId: string): Promise<boolean> {
  const order = await db.order.findUnique({ where: { id: orderId }, select: { shippedAt: true, deliveredAt: true } })
  if (order?.shippedAt || order?.deliveredAt) return true
  if (await db.stockReservation.count({ where: { orderId, consumedAt: { not: null } } })) return true
  if (await db.stockMovement.count({ where: { orderId, reason: 'RESERVATION_CONSUMED', change: { lt: 0 } } })) return true
  if ((await db.shipment.count({ where: { orderId, status: { in: [...PICKED_UP] } } })) > 0) return true
  // Asked only of a business that ever sold from shared stock (its links are its own rows).
  if (!(await db.stockPoolLink.findFirst({ select: { id: true } }))) return false
  const { poolOrderShipped } = await import('../stock-pool/pool-doors.js')
  return await poolOrderShipped(db as never, orderId)
}

const object = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null

/** Shopify: units per line item in its fulfilments (a cancelled or failed fulfilment shipped nothing). */
export function shopifyFulfilledUnits(metadata: unknown): Map<string, number> | null {
  const fulfillments = object(metadata)?.fulfillments
  if (!Array.isArray(fulfillments)) return null
  const units = new Map<string, number>()
  for (const fulfillment of fulfillments) {
    const row = object(fulfillment)
    if (!row || ['cancelled', 'error', 'failure'].includes(String(row.status ?? 'success'))) continue
    for (const value of Array.isArray(row.line_items) ? row.line_items : []) {
      const line = object(value)
      const quantity = Number(line?.quantity)
      if (line?.id != null && Number.isSafeInteger(quantity) && quantity > 0) units.set(String(line.id), (units.get(String(line.id)) ?? 0) + quantity)
    }
  }
  return units
}

/**
 * C1 — per product, the units the channel says shipped, from its own line data: Amazon's
 * QuantityShipped per order item, eBay's line fulfilment status (FULFILLED all, NOT_STARTED none),
 * Etsy's per-line shipped time, Shopify's fulfilments. A product with any line the channel does not
 * describe is unknown.
 */
export async function orderShippedUnits(db: Pick<Prisma.TransactionClient, 'order'>, orderId: string): Promise<ShippedUnits> {
  const order = await db.order.findUnique({ where: { id: orderId }, select: { channel: true, shopifyMetadata: true, etsyMetadata: true,
    items: { select: { productId: true, quantity: true, externalLineItemId: true, amazonMetadata: true, ebayMetadata: true } } } })
  const out: ShippedUnits = { known: new Map(), unknown: new Set() }
  if (!order) return out
  const shopify = order.channel === 'SHOPIFY' ? shopifyFulfilledUnits(order.shopifyMetadata) : null
  const etsyLines = order.channel === 'ETSY' ? object(object(order.etsyMetadata)?.lines) : null
  for (const item of order.items) {
    if (!item.productId || !(item.quantity > 0)) continue
    let units: number | null = null
    if (order.channel === 'AMAZON') {
      const shipped = object(item.amazonMetadata)?.QuantityShipped
      units = typeof shipped === 'number' && Number.isSafeInteger(shipped) && shipped >= 0 ? Math.min(shipped, item.quantity) : null
    } else if (order.channel === 'EBAY') {
      const status = object(item.ebayMetadata)?.fulfillmentStatus
      units = status === 'FULFILLED' ? item.quantity : status === 'NOT_STARTED' ? 0 : null
    } else if (order.channel === 'ETSY') {
      const line = item.externalLineItemId ? object(etsyLines?.[item.externalLineItemId]) : null
      units = line ? (line.shippedAt != null ? item.quantity : 0) : null
    } else if (order.channel === 'SHOPIFY' && shopify && item.externalLineItemId) {
      units = Math.min(shopify.get(item.externalLineItemId) ?? 0, item.quantity)
    }
    if (units === null) out.unknown.add(item.productId)
    else out.known.set(item.productId, (out.known.get(item.productId) ?? 0) + units)
  }
  for (const productId of out.unknown) out.known.delete(productId)
  return out
}

/**
 * R4 + C1 — null: nothing of the order shipped. Otherwise what the channel says shipped, per product.
 * A line that says it shipped is evidence by itself (a Shopify partial fulfilment sets no shipped time).
 * Evidence of a shipment while every line the channel describes says nothing shipped is a disagreement:
 * then no product is known, and nothing is released on a guess.
 */
export async function cancelledShipment(db: ShipmentDb & Pick<Prisma.TransactionClient, '$queryRaw' | 'stockPoolLink'>, orderId: string): Promise<ShippedUnits | null> {
  const units = await orderShippedUnits(db, orderId)
  const byLines = [...units.known.values()].some((n) => n > 0)
  if (!byLines && !(await orderShipmentEvidence(db, orderId))) return null
  if (!byLines) return { known: new Map(), unknown: new Set([...units.known.keys(), ...units.unknown]) }
  return units
}

type LedgerDb = Pick<Prisma.TransactionClient, 'stockMovement' | 'return'>

/** Both ledgers are durable markers: lender movements are hidden by the borrower's ordinary RLS.
 *  After (part of) the order shipped (R4, C1) only own units the channel says did not ship can be owed;
 *  shared stock is settled by the cancellation itself and not re-driven here. */
export async function orderRestorePending(db: LedgerDb & ShipmentDb & Pick<Prisma.TransactionClient, '$queryRaw' | 'stockPoolLink'>, orderId: string): Promise<boolean> {
  const shipped = await cancelledShipment(db, orderId)
  if (shipped) return await ownRestorePending(db, orderId, shipped)
  if (await ownRestorePending(db, orderId)) return true
  const [pool] = await db.$queryRaw<Array<{ pending: boolean }>>`SELECT nexus_pool_restore_pending(${orderId}) AS pending`
  return pool.pending
}

/**
 * The stock half of a cancellation for units taken AT INGEST (eBay): pool units back through door 5
 * (capped at what the order took from the pool), then own units from the order's own ledger.
 * Idempotent; safe to re-run. Nothing shipped: everything taken comes back. After (part of) the order
 * shipped (R4, C1): only the units the channel says did not ship come back, per product, own and
 * shared; a product the channel does not describe keeps its units deducted (`kept`). `shipped` says
 * so; the caller tells the owners.
 */
export async function restoreCancelledOrderStock(orderId: string, actor = 'system:order-cancellation'): Promise<{
  itemsRestocked: number; units: number; shipped: boolean
  kept: Array<{ productId: string; quantity: number; side: 'taken' }>
  errors: Array<{ itemId: string; error: string }>
}> {
  const out = { itemsRestocked: 0, units: 0, shipped: false, kept: [] as Array<{ productId: string; quantity: number; side: 'taken' }>, errors: [] as Array<{ itemId: string; error: string }> }
  const shipped = await cancelledShipment(prisma, orderId)
  out.shipped = shipped !== null
  const orderItems = await prisma.orderItem.findMany({ where: { orderId }, select: { productId: true, quantity: true } })
  const { putBackForOrder } = await import('../stock-pool/order-routing.js')
  for (const productId of [...new Set(orderItems.filter(it => it.productId && it.quantity > 0).map(it => it.productId!))].sort()) {
    const ordered = orderItems.filter(it => it.productId === productId).reduce((sum, it) => sum + Math.max(0, it.quantity), 0)
    const shippedUnits = !shipped ? 0 : shipped.unknown.has(productId) || !shipped.known.has(productId) ? null : shipped.known.get(productId)!
    if (shippedUnits === null) {
      // Shared stock the channel does not describe: its units stay taken (reported below, with the own ones).
      if (await prisma.stockPoolLink.findFirst({ where: { productId }, select: { id: true } })) {
        const { poolOrderTaken } = await import('../stock-pool/pool-doors.js')
        const taken = await poolOrderTaken(prisma, { orderRef: orderId, productId })
        if (taken > 0) out.kept.push({ productId, quantity: taken, side: 'taken' })
      }
      continue
    }
    if (ordered - shippedUnits <= 0) continue
    try {
      // Shared stock: the units that did not ship go back (door 5, once per order and product).
      const args = { productId, orderId, putBackRef: orderId, reason: 'ORDER_CANCELLED' as const, actor }
      let asked = ordered - shippedUnits
      let pooled = await putBackForOrder({ ...args, quantity: asked })
      // A line the door reused (one take per order and product) took nothing: give back what was taken
      // and did not ship.
      const refusal = pooled.via === 'none' ? (pooled as { refusal: { code: string; taken?: unknown; returned?: unknown } }).refusal : null
      if (refusal?.code === 'more_than_sold') {
        const remaining = Number(refusal.taken) - shippedUnits - Number(refusal.returned)
        if (Number.isSafeInteger(remaining) && remaining > 0) pooled = await putBackForOrder({ ...args, quantity: (asked = remaining) })
      }
      if (pooled.via === 'pool' && !pooled.reused) { out.itemsRestocked++; out.units += asked }
    } catch (err) {
      out.errors.push({ itemId: productId, error: `Shared stock put back ${productId}: ${err instanceof Error ? err.message : String(err)}` })
    }
  }
  const own = await giveBackOrderTakes(orderId, actor, shipped)
  out.itemsRestocked += own.restored
  out.units += own.units
  out.errors.push(...own.errors)
  if (shipped) {
    // What stays deducted because the channel does not say whether it shipped: own units taken at ingest.
    const ledger = await prisma.stockMovement.groupBy({ by: ['productId'], where: { orderId, reason: { in: ['ORDER_PLACED', 'ORDER_CANCELLED'] } }, _sum: { change: true } })
    for (const row of ledger) {
      const net = -(row._sum.change ?? 0)
      if (net > 0 && (shipped.unknown.has(row.productId) || !shipped.known.has(row.productId))) out.kept.push({ productId: row.productId, quantity: net, side: 'taken' })
    }
  }
  return out
}

/** What a cancellation after (part of) a shipment did, for the owners' notice. */
export interface AfterShipmentSummary {
  /** Units that had not shipped and went back on sale (holds given back, units put back). */
  putBack: number
  /** Units whose fate the channel does not say: held for the order, held in shared stock, or still deducted. */
  kept: Array<{ productId: string; quantity: number; side: 'own' | 'pool' | 'taken' }>
}

/**
 * R4 — one notice per order, however often the cancellation is re-run and whichever path raises it
 * (E3, the reconcile, or the Etsy writer inside its own transaction): a stable occurrence id. The
 * words say exactly what happened (C1): nothing that shipped came back, how many units that had not
 * shipped went back on sale, and what is still held or deducted because the channel does not say —
 * with the one safe action, a stock-page release of this order's own hold. They never suggest a stock
 * change that could count a unit twice. A Shopify or Etsy refund is called a refund (C5).
 */
export async function noticeCancelledAfterShipment(orderId: string, summary: AfterShipmentSummary, db: Pick<Prisma.TransactionClient, 'order' | 'notification' | 'workspaceMembership' | 'product'> = prisma): Promise<void> {
  const order = await db.order.findUnique({ where: { id: orderId }, select: { workspaceId: true, channel: true, channelOrderId: true, status: true, shopifyMetadata: true } })
  if (!order) return
  const shopify = object(order.shopifyMetadata)
  const refunded = order.status === 'REFUNDED' || (order.channel === 'SHOPIFY' && shopify?.financial_status === 'refunded' && !shopify?.cancelled_at)
  const kept = summary.kept.filter((row) => row.quantity > 0)
  const skus = new Map((kept.length ? await db.product.findMany({ where: { id: { in: [...new Set(kept.map((row) => row.productId))] } }, select: { id: true, sku: true } }) : []).map((p) => [p.id, p.sku]))
  const unsure = (side: 'own' | 'pool' | 'taken', what: (they: string, stay: string) => string) => {
    const rows = kept.filter((row) => row.side === side)
    if (!rows.length) return null
    const one = rows.length === 1 && rows[0].quantity === 1
    const list = rows.map((row) => `${row.quantity} × ${skus.get(row.productId) ?? row.productId}`).join(', ')
    return `Nexus cannot tell from ${order.channel} whether ${list} shipped, so ${what(one ? 'it' : 'they', one ? 'stays' : 'stay')}`
  }
  const sentences = [
    'Nothing that shipped was put back into stock; when a parcel comes back, book it in as a return to put its units back.',
    summary.putBack > 0 ? `${summary.putBack} ${summary.putBack === 1 ? 'unit that had not shipped was' : 'units that had not shipped were'} put back on sale.` : null,
    unsure('own', (they, stay) => `${they} ${stay} held for this order. If ${they} did not ship, release this order's hold on the stock page.`),
    unsure('pool', (they, stay) => `${they} ${stay} held in shared stock for this order. If ${they} did not ship, ask the business that lends you this stock to release this order's hold on its Stock → Reservations page.`),
    unsure('taken', (they, stay) => `${they} ${stay} deducted.`),
  ].filter((sentence): sentence is string => sentence !== null)
  const { raiseChannelAlertInTx } = await import('../cx/channel-alerts.service.js')
  await raiseChannelAlertInTx(db, {
    kind: 'channel-order-cancelled-after-shipment', severity: 'warn',
    title: `${order.channel} order ${order.channelOrderId} was ${refunded ? 'refunded' : 'cancelled'} after (part of) it shipped`,
    body: sentences.join(' '),
    entityType: 'Order', entityId: orderId, href: `/orders/${orderId}`,
    meta: { channel: order.channel, channelOrderId: order.channelOrderId, refunded, putBack: summary.putBack, kept },
  }, { workspaceId: order.workspaceId, actorUserId: null, occurrenceId: `cancelled-after-shipment:${orderId}` })
}

/**
 * The holds of a cancelled or refunded order, in the caller's transaction (the caller has locked the
 * order's products): given back when nothing shipped, else settled by what the channel says shipped
 * (C1, `settleOrderHoldsInTx`).
 */
export async function settleCancelledOrderHoldsInTx(tx: Prisma.TransactionClient, args: { orderId: string; actor?: string; reason?: string }): Promise<SettledOrderHolds & { shipped: boolean }> {
  const shipped = await cancelledShipment(tx, args.orderId)
  return { ...(await settleOrderHoldsInTx(tx, { ...args, shipped })), shipped: shipped !== null }
}

/** The same in its own transaction, under the order-stock lock door (the order's products and their pool sources). */
export async function settleCancelledOrderHolds(orderId: string, args: { actor?: string; reason?: string } = {}): Promise<SettledOrderHolds & { shipped: boolean }> {
  const outcome = await prisma.$transaction(async (tx) => {
    const lines = await tx.orderItem.findMany({ where: { orderId, productId: { not: null } }, select: { productId: true } })
    const held = await tx.stockReservation.findMany({ where: { orderId, releasedAt: null, consumedAt: null }, select: { stockLevel: { select: { productId: true } } } })
    const products = [...new Set([...lines.map((line) => line.productId!), ...held.map((hold) => hold.stockLevel.productId)])]
    // With the order reference, the door also locks the sources of the order's open pool holds (door 3
    // gives back every one, also a hold whose product is on no line any more): one sorted set.
    await tx.$executeRaw`SELECT nexus_lock_order_stock(${products}::text[], ${orderId})`
    return settleCancelledOrderHoldsInTx(tx, { orderId, ...args })
  }, { isolationLevel: 'ReadCommitted', maxWait: 5_000, timeout: 30_000 })
  await afterOrderHoldsCommit(outcome.after)
  return outcome
}

const POST_PICKUP_STATUSES = ['SHIPPED', 'IN_TRANSIT'] as const

export async function handleOrderCancelled(
  orderId: string,
): Promise<CancellationCleanupResult> {
  const result: CancellationCleanupResult = {
    orderId,
    shipmentsScanned: 0,
    shipmentsCancelled: 0,
    parcelsVoided: 0,
    parcelsVoidFailed: 0,
    itemsRestocked: 0,
    reservationsReleased: 0,
    shippedBeforeCancel: false,
    errors: [],
  }

  const shipments = await prisma.shipment.findMany({
    where: { orderId },
    select: {
      id: true,
      status: true,
      sendcloudParcelId: true,
      trackingNumber: true,
      heldReason: true,
    },
  })
  result.shipmentsScanned = shipments.length

  // Defer the heavy imports so callers that pass in non-cancelled
  // orders (defensive) don't pay for the modules.
  const [
    { publishOutboundEvent },
    { publishOrderEvent },
    { auditLogService },
    sendcloud,
    { recascadeProduct },
  ] = await Promise.all([
    import('../outbound-events.service.js'),
    import('../order-events.service.js'),
    import('../audit-log.service.js'),
    import('../sendcloud/index.js'),
    import('../stock-movement.service.js'),
  ])

  // O.6: emit the order-level cancellation event up front. The
  // shipment.deleted events fired further down handle the outbound
  // surface; this one drives the /orders SSE channel so the badge
  // flips and the PENDING facet count drops without operator F5.
  try {
    publishOrderEvent({
      type: 'order.cancelled',
      orderId,
      ts: Date.now(),
    })
  } catch {
    // bus failure must not abort the cascade
  }

  // O.21a: refresh the linked Customer's aggregate cache. Cancelled
  // orders are excluded from LTV (totalSpentCents) per the cache
  // service, so totalOrders + totalSpentCents both step down on a
  // cascade. Fire-and-forget; a customer-side failure must not
  // abort the cancel.
  void (async () => {
    try {
      const { linkAndRefreshCustomerForOrder } = await import(
        '../customer-cache.service.js'
      )
      await linkAndRefreshCustomerForOrder(orderId)
    } catch (err) {
      auditLogService.write({
        entityType: 'Order',
        entityId: orderId,
        action: 'customer-cache-refresh-failed',
        metadata: { error: err instanceof Error ? err.message : String(err) },
      }).catch(() => {})
    }
  })()

  // S.2: Stock restoration. Two patterns coexist depending on how the
  // channel ingestion path handles stock:
  //   - reserve-then-consume (Amazon FBM today; Shopify in S.2.5):
  //     ingestion called reserveOpenOrder. Cancellation releases the
  //     reservation — frees `available` without touching `quantity`.
  //   - decrement-at-creation (eBay today): ingestion called
  //     applyStockMovement(-qty, ORDER_PLACED). Cancellation restores
  //     via applyStockMovement(+qty, ORDER_CANCELLED).
  //
  // Open holds are released first; then whatever the order actually took comes back (E3, below).
  // Idempotent: release is a no-op on settled holds, and restores are marked per taking movement.

  // IS.2 — read order items upfront so we can cascade the stock
  // release to other channels regardless of which restore path fires.
  const orderItemsForCascade = await prisma.orderItem.findMany({
    where: { orderId },
    select: { productId: true, quantity: true },
  })

  // C1 — open holds: given back when nothing shipped; after a partial shipment, what the channel says
  // shipped is taken and the rest given back; a product it does not describe keeps its hold.
  let settled: Awaited<ReturnType<typeof settleCancelledOrderHolds>> | null = null
  try {
    settled = await settleCancelledOrderHolds(orderId, { actor: 'system:order-cancellation', reason: 'order cancelled by channel' })
    const released = settled.released + settled.consumed
    result.reservationsReleased = settled.released

    // IS.2 → RT.2 — reservation release doesn't go through applyStockMovement,
    // so run the CANONICAL cascade instead of the old hand-rolled row loop
    // (which read a single un-location-filtered StockLevel row — latent FBA
    // bleed — and skipped shared-eBay fan-out, Follow/FBA filtering, the
    // ChannelListing.quantity write, and coalescing; 15s hold).
    // reason ORDER_CANCELLED ⇒ 0-hold, priority-1 instant dispatch (~2s).
    if (released > 0) {
      void (async () => {
        try {
          for (const it of orderItemsForCascade) {
            if (!it.productId) continue
            const res = await recascadeProduct(it.productId, {
              reason: 'ORDER_CANCELLED',
              referenceType: 'ORDER',
              referenceId: orderId,
              actor: 'order-cancellation:IS.2',
            })
            if (res.ok === false) {
              auditLogService.write({
                entityType: 'Order',
                entityId: orderId,
                action: 'IS2-recascade-refused-no-ledger',
                metadata: { productId: it.productId, totalStock: res.totalStock },
              }).catch(() => {})
            }
          }
        } catch (err) {
          auditLogService.write({
            entityType: 'Order',
            entityId: orderId,
            action: 'IS2-cascade-failed',
            metadata: { error: err instanceof Error ? err.message : String(err) },
          }).catch(() => {})
        }
      })()
    }
  } catch (err: any) {
    result.errors.push({
      itemId: 'reservation-release',
      error: `Reservation release: ${err?.message ?? String(err)}`,
    })
  }

  // E3 — the units the order took at ingest come back: pool units through door 5, own units per
  // taking movement. Not gated on released holds any more: a released hold took nothing, so it has
  // nothing to give back, and a re-run after a release no longer invents stock. R4: nothing comes
  // back once (part of) the order shipped — the owners are told, once, to check the parcel.
  const restored = await restoreCancelledOrderStock(orderId)
  result.itemsRestocked += restored.itemsRestocked
  result.errors.push(...restored.errors)
  if (restored.shipped || settled?.shipped) {
    result.shippedBeforeCancel = true
    try {
      await noticeCancelledAfterShipment(orderId, {
        putBack: (settled?.releasedUnits ?? 0) + restored.units,
        kept: [...(settled?.kept ?? []), ...restored.kept],
      })
    } catch (err) {
      result.errors.push({ itemId: 'owner-notice', error: `Owner notice: ${err instanceof Error ? err.message : String(err)}` })
    }
  }

  if (shipments.length === 0) return result

  for (const s of shipments) {
    if (TERMINAL_STATUSES.includes(s.status as any)) continue

    // Try to void at Sendcloud only when the parcel exists AND the
    // carrier hasn't picked it up yet. Post-pickup voids waste an API
    // call + Sendcloud rejects them anyway.
    const shouldAttemptVoid =
      s.sendcloudParcelId !== null
      && !POST_PICKUP_STATUSES.includes(s.status as any)

    if (shouldAttemptVoid && s.sendcloudParcelId) {
      try {
        const creds = await sendcloud.resolveCredentials()
        const voidRes = await sendcloud.voidParcel(creds, Number(s.sendcloudParcelId))
        if (voidRes.ok) result.parcelsVoided++
        else {
          result.parcelsVoidFailed++
          result.errors.push({
            shipmentId: s.id,
            error: `Sendcloud void: ${(voidRes as { ok: false; reason: string }).reason}`,
          })
        }
      } catch (err: any) {
        result.parcelsVoidFailed++
        result.errors.push({
          shipmentId: s.id,
          error: err?.message ?? String(err),
        })
      }
    }

    // Transition our side regardless — the order IS cancelled per
    // the channel; the shipment row should reflect that even when
    // Sendcloud refuses the void (operator can manually intervene
    // via the existing void-label endpoint if needed).
    try {
      await prisma.shipment.update({
        where: { id: s.id },
        data: {
          status: 'CANCELLED',
          cancelledAt: new Date(),
          version: { increment: 1 },
        },
      })
      result.shipmentsCancelled++

      void auditLogService.write({
        entityType: 'Shipment',
        entityId: s.id,
        action: 'auto-cancel-from-order',
        before: { status: s.status, sendcloudParcelId: s.sendcloudParcelId },
        after: { status: 'CANCELLED' },
        metadata: { reason: 'Order cancelled by channel', orderId },
      })

      publishOutboundEvent({
        type: 'shipment.deleted',
        shipmentId: s.id,
        ts: Date.now(),
      })
    } catch (err: any) {
      result.errors.push({
        shipmentId: s.id,
        error: err?.message ?? String(err),
      })
    }
  }

  return result
}

export const __test = { TERMINAL_STATUSES, POST_PICKUP_STATUSES }
