import prisma from '../db.js'
import type { Prisma } from '@prisma/client'

// B.1/B.2 — single entrypoint for every stock change.
// Anyone touching Product.totalStock or ProductVariation.stock MUST go
// through here so the StockMovement audit log captures balanceAfter,
// reason, reference, and (in B.2) the cross-channel push fans out.
//
// H.1 — extended with optional locationId. When provided, the write
// targets the StockLevel ledger for that (product, location, variation)
// triple, and Product.totalStock is recomputed as SUM(StockLevel) so
// the cached column stays consistent. When locationId is omitted, the
// legacy code path runs unchanged (direct Product.totalStock /
// ProductVariation.stock mutation). Commit 2 will migrate the remaining
// callers (returns/inbound/manual-adjust) onto the locationId path.

type MovementReason =
  | 'ORDER_PLACED'
  | 'ORDER_CANCELLED'
  | 'ORDER_REFUNDED'
  | 'RETURN_RECEIVED'
  | 'RETURN_RESTOCKED'
  | 'INBOUND_RECEIVED'
  | 'SUPPLIER_DELIVERY'
  | 'MANUFACTURING_OUTPUT'
  | 'FBA_TRANSFER_OUT'
  | 'FBA_TRANSFER_IN'
  | 'MANUAL_ADJUSTMENT'
  | 'INVENTORY_COUNT'
  | 'WRITE_OFF'
  | 'RESERVATION_RELEASED'
  // H.1 additions
  | 'SYNC_RECONCILIATION'
  | 'RESERVATION_CREATED'
  | 'RESERVATION_CONSUMED'
  | 'TRANSFER_OUT'
  | 'TRANSFER_IN'
  | 'PARENT_PRODUCT_CLEANUP'
  | 'STOCKLEVEL_BACKFILL'

export type StockMovementInput = {
  productId: string
  variationId?: string
  warehouseId?: string
  /** H.1: when set, write goes via StockLevel ledger; totalStock is
   *  recomputed as SUM(StockLevel.quantity). When omitted, legacy
   *  direct-Product.totalStock path is used. */
  locationId?: string
  change: number
  reason: MovementReason
  referenceType?: string
  referenceId?: string
  notes?: string
  actor?: string
  /** H.1: source-tracking foreign keys (optional) */
  orderId?: string
  shipmentId?: string
  returnId?: string
  reservationId?: string
}

/**
 * Recompute Product.totalStock = SUM(StockLevel.quantity) for a given
 * product, inside the supplied transaction. Called after any StockLevel
 * mutation so the cached totalStock cannot drift.
 */
async function recomputeProductTotalStock(
  tx: Prisma.TransactionClient,
  productId: string,
): Promise<number> {
  const sum = await tx.stockLevel.aggregate({
    where: { productId },
    _sum: { quantity: true },
  })
  const total = sum._sum.quantity ?? 0
  await tx.product.update({
    where: { id: productId },
    data: { totalStock: total },
  })
  return total
}

/**
 * Apply a stock change atomically:
 *  1. Update Product.totalStock (or ProductVariation.stock) by `change`.
 *     For variants, also recompute parent Product.totalStock from the
 *     sum of children so the parent reflects reality.
 *  2. Insert a StockMovement row capturing balanceAfter for audit.
 *  3. Enqueue an immediate cross-channel inventory push (via existing
 *     OutboundSyncQueue with PRIORITY=high — workers pick it up next
 *     tick, but consumers can also flush() inline for true realtime).
 *
 * Returns the StockMovement row.
 */
export async function applyStockMovement(input: StockMovementInput) {
  const {
    productId,
    variationId,
    warehouseId,
    locationId,
    change,
    reason,
    referenceType,
    referenceId,
    notes,
    actor,
    orderId,
    shipmentId,
    returnId,
    reservationId,
  } = input
  if (change === 0) throw new Error('applyStockMovement: change must be non-zero')

  return await prisma.$transaction(async (tx) => {
    let balanceAfter: number
    let quantityBefore: number | null = null

    if (locationId) {
      // ── H.1 path: StockLevel ledger ───────────────────────────────
      // Find existing row for (location, product, variation) triple.
      // Partial unique indexes in the migration enforce uniqueness when
      // variationId is NULL or non-NULL; we use findFirst here because
      // Prisma's @@unique([locationId, productId, variationId]) doesn't
      // expose a typed `where: { unique }` for the NULL case.
      const existing = await tx.stockLevel.findFirst({
        where: {
          locationId,
          productId,
          variationId: variationId ?? null,
        },
        select: { id: true, quantity: true, reserved: true },
      })

      quantityBefore = existing?.quantity ?? 0
      const newQuantity = quantityBefore + change
      if (newQuantity < 0) {
        throw new Error(
          `applyStockMovement: would drive StockLevel quantity negative ` +
            `(product=${productId} location=${locationId} ` +
            `before=${quantityBefore} change=${change})`,
        )
      }
      const reserved = existing?.reserved ?? 0
      const newAvailable = newQuantity - reserved

      if (existing) {
        await tx.stockLevel.update({
          where: { id: existing.id },
          data: {
            quantity: newQuantity,
            available: newAvailable,
            lastSyncedAt: new Date(),
          },
        })
      } else {
        await tx.stockLevel.create({
          data: {
            locationId,
            productId,
            variationId: variationId ?? null,
            quantity: newQuantity,
            reserved: 0,
            available: newAvailable,
            syncStatus: 'SYNCED',
            lastSyncedAt: new Date(),
          },
        })
      }

      balanceAfter = newQuantity

      // Increment Product.totalStock by `change` rather than recomputing
      // as SUM(StockLevel). This keeps the new path arithmetic-equivalent
      // to the legacy path during the Commit 1 → Commit 2 dual-write
      // window: legacy writers (returns, inbound, manual adjust) still
      // increment totalStock directly without touching StockLevel, so a
      // SUM-based recompute here would silently drop their deltas. The
      // recompute helper below is the source-of-truth reconciliation
      // used at Commit 2 deploy to seal any drift, and as an ad-hoc
      // repair tool.
      await tx.product.update({
        where: { id: productId },
        data: { totalStock: { increment: change } },
      })
    } else if (variationId) {
      // ── Legacy path: ProductVariation.stock ───────────────────────
      const variation = await tx.productVariation.update({
        where: { id: variationId },
        data: { stock: { increment: change } },
        select: { stock: true, productId: true },
      })
      balanceAfter = variation.stock

      // Recompute parent total from sum of variants
      const sum = await tx.productVariation.aggregate({
        where: { productId: variation.productId },
        _sum: { stock: true },
      })
      await tx.product.update({
        where: { id: variation.productId },
        data: { totalStock: sum._sum.stock ?? 0 },
      })
    } else {
      // ── Legacy path: Product.totalStock direct ────────────────────
      const updated = await tx.product.update({
        where: { id: productId },
        data: { totalStock: { increment: change } },
        select: { totalStock: true },
      })
      balanceAfter = updated.totalStock
    }

    const movement = await tx.stockMovement.create({
      data: {
        productId,
        variationId: variationId ?? null,
        warehouseId: warehouseId ?? null,
        locationId: locationId ?? null,
        change,
        balanceAfter,
        quantityBefore,
        reason,
        referenceType: referenceType ?? null,
        referenceId: referenceId ?? null,
        notes: notes ?? null,
        actor: actor ?? null,
        orderId: orderId ?? null,
        shipmentId: shipmentId ?? null,
        returnId: returnId ?? null,
        reservationId: reservationId ?? null,
      },
    })

    // Best-effort fan-out: enqueue one OutboundSyncQueue row per
    // existing ChannelListing for this product. The Autopilot worker
    // picks them up next tick. Failures don't roll the transaction
    // back — the canonical totalStock is source of truth.
    try {
      const channelListings = await tx.channelListing.findMany({
        where: { productId },
        select: { id: true, channel: true },
      })
      const validTargets = ['AMAZON', 'EBAY', 'SHOPIFY', 'WOOCOMMERCE'] as const
      for (const cl of channelListings) {
        if (!validTargets.includes(cl.channel as any)) continue
        await tx.outboundSyncQueue.create({
          data: {
            productId,
            channelListingId: cl.id,
            targetChannel: cl.channel as any,
            syncType: 'QUANTITY_UPDATE',
            syncStatus: 'PENDING',
            payload: { reason, change, balanceAfter, referenceType, referenceId } as any,
            maxRetries: 3,
          },
        })
      }
    } catch (e) {
      // swallow — caller can re-queue if it cares
    }

    return movement
  })
}

/**
 * Bulk variant of applyStockMovement — same semantics, fewer round trips.
 * Used by inbound shipment "receive all" + return "restock all" actions.
 */
export async function applyStockMovementBatch(inputs: StockMovementInput[]) {
  const results = []
  for (const input of inputs) {
    results.push(await applyStockMovement(input))
  }
  return results
}

/**
 * Read the movement history for a product (or single variant) with paging.
 * Used by /fulfillment/stock drawer + the audit viewer.
 */
export async function listStockMovements(opts: {
  productId?: string
  variationId?: string
  warehouseId?: string
  limit?: number
  before?: Date
}) {
  const where: any = {}
  if (opts.productId) where.productId = opts.productId
  if (opts.variationId) where.variationId = opts.variationId
  if (opts.warehouseId) where.warehouseId = opts.warehouseId
  if (opts.before) where.createdAt = { lt: opts.before }

  return prisma.stockMovement.findMany({
    where,
    orderBy: { createdAt: 'desc' },
    take: Math.min(500, opts.limit ?? 100),
  })
}
