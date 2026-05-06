import prisma from '../db.js'
import type { Prisma } from '@prisma/client'

// B.1/B.2 — single entrypoint for every stock change.
// Anyone touching Product.totalStock or ProductVariation.stock MUST go
// through here so the StockMovement audit log captures balanceAfter,
// reason, reference, and (in B.2) the cross-channel push fans out.
//
// H.1/H.2 — multi-location StockLevel ledger.
//
// Resolution order for the location of a movement:
//   1. explicit `locationId` argument
//   2. `warehouseId` argument → joined to StockLocation.warehouseId
//   3. fallback: IT-MAIN (Riccione) — physical Xavia warehouse
//
// Once resolved, the write targets the StockLevel row for
// (location, product, variation) and Product.totalStock is
// recomputed as SUM(StockLevel.quantity). The legacy variationId
// branch (no locationId, no warehouseId, has variationId) remains
// for the unlikely case a caller targets a single variant directly
// without specifying a location; current production has zero
// ProductVariation rows so this path is dormant.

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
export async function recomputeProductTotalStock(
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
 * Resolve the StockLocation for a movement using the H.2 precedence:
 *   explicit locationId > warehouseId-derived > IT-MAIN fallback.
 *
 * Cached at module level for IT-MAIN since it's the hot path.
 */
let cachedDefaultLocationId: string | null = null
async function resolveLocationId(
  tx: Prisma.TransactionClient,
  args: { locationId?: string; warehouseId?: string },
): Promise<string> {
  if (args.locationId) return args.locationId
  if (args.warehouseId) {
    const sl = await tx.stockLocation.findUnique({
      where: { warehouseId: args.warehouseId },
      select: { id: true },
    })
    if (sl) return sl.id
  }
  if (cachedDefaultLocationId) return cachedDefaultLocationId
  const itMain = await tx.stockLocation.findUnique({
    where: { code: 'IT-MAIN' },
    select: { id: true },
  })
  if (!itMain) {
    throw new Error(
      'applyStockMovement: IT-MAIN StockLocation missing — run H.1 backfill',
    )
  }
  cachedDefaultLocationId = itMain.id
  return itMain.id
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
    // H.2 — every movement now resolves to a StockLocation. Legacy
    // (no locationId, no warehouseId) callers transparently land on
    // IT-MAIN.
    const resolvedLocationId = await resolveLocationId(tx, {
      locationId,
      warehouseId,
    })

    const existing = await tx.stockLevel.findFirst({
      where: {
        locationId: resolvedLocationId,
        productId,
        variationId: variationId ?? null,
      },
      select: { id: true, quantity: true, reserved: true },
    })

    const quantityBefore = existing?.quantity ?? 0
    const newQuantity = quantityBefore + change
    if (newQuantity < 0) {
      throw new Error(
        `applyStockMovement: would drive StockLevel quantity negative ` +
          `(product=${productId} location=${resolvedLocationId} ` +
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
          locationId: resolvedLocationId,
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

    const balanceAfter = newQuantity

    // Variant stock mirrored on ProductVariation.stock for any caller
    // still reading that column directly. ProductVariation has zero
    // rows in current production but the field remains schema-live.
    if (variationId) {
      await tx.productVariation.update({
        where: { id: variationId },
        data: { stock: { increment: change } },
      })
    }

    // Product.totalStock as cached SUM(StockLevel.quantity). Single
    // source of truth across all locations for the H.2 world.
    await recomputeProductTotalStock(tx, productId)

    const movement = await tx.stockMovement.create({
      data: {
        productId,
        variationId: variationId ?? null,
        warehouseId: warehouseId ?? null,
        locationId: resolvedLocationId,
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
