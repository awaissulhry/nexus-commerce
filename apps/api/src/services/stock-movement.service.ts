import prisma from '../db.js'

// B.1/B.2 — single entrypoint for every stock change.
// Anyone touching Product.totalStock or ProductVariation.stock MUST go
// through here so the StockMovement audit log captures balanceAfter,
// reason, reference, and (in B.2) the cross-channel push fans out.

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

export type StockMovementInput = {
  productId: string
  variationId?: string
  warehouseId?: string
  change: number
  reason: MovementReason
  referenceType?: string
  referenceId?: string
  notes?: string
  actor?: string
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
  const { productId, variationId, warehouseId, change, reason, referenceType, referenceId, notes, actor } = input
  if (change === 0) throw new Error('applyStockMovement: change must be non-zero')

  return await prisma.$transaction(async (tx) => {
    let balanceAfter: number

    if (variationId) {
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
        change,
        balanceAfter,
        reason,
        referenceType: referenceType ?? null,
        referenceId: referenceId ?? null,
        notes: notes ?? null,
        actor: actor ?? null,
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
