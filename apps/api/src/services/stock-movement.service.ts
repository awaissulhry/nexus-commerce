import prisma from '../db.js'
import type { Prisma } from '@prisma/client'
import { outboundSyncQueue } from '../lib/queue.js'
import { logger } from '../utils/logger.js'
import { handleMovementStockoutTransition } from './stockout-detector.service.js'
import { consumeLayersInTx, receiveLayerInTx } from './cost-layers.service.js'

// S.20 — reasons that consume cost layers (decrease quantity AND
// realise COGS). Manual-adjustment subtractions also consume; the
// audit row carries the WRITE_OFF tag in those flows.
const CONSUME_REASONS = new Set([
  'ORDER_PLACED', 'ORDER_REFUNDED', 'WRITE_OFF', 'RESERVATION_CONSUMED',
  'FBA_TRANSFER_OUT', 'TRANSFER_OUT',
])
// S.20 — reasons that should create a fresh cost layer (a receive
// event of some kind). RETURN_RESTOCKED uses the original
// orderItem unit cost — caller handles that explicitly via
// receiveLayer; here we only flag pure receives so the post-tx
// hook auto-layers PO inbounds without operator intervention.
const RECEIVE_AUTO_LAYER_REASONS = new Set([
  'INBOUND_RECEIVED', 'SUPPLIER_DELIVERY', 'MANUFACTURING_OUTPUT',
  'TRANSFER_IN',
])

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
//
// Phase 13 (master-data cascade) — symmetric with MasterPriceService.
//   After the stock write commits, every ChannelListing tied to the
//   product gets:
//     masterQuantity := newTotal               (always — snapshot for drift)
//     if followMasterQuantity = true:
//        quantity := max(0, newTotal - stockBuffer)  (Phase 23.2 oversell guard)
//        lastSyncStatus := PENDING
//     OutboundSyncQueue row enqueued with syncType='QUANTITY_UPDATE',
//     holdUntil = NOW + 5min (matches PHASE 12a undo grace).
//   Listings whose quantity didn't change (followMasterQuantity=false, or
//   bufferless qty already correct) only get the masterQuantity snapshot.
//   Cascade runs in the same transaction as the stock write; cascade
//   failures roll the entire mutation back (data corruption beats
//   silent drift). BullMQ enqueue happens after commit; Redis failures
//   leave the DB row PENDING for the next drain pass.

// Phase 13 — 5-minute grace window before the worker pushes to the
// marketplace. Same value MasterPriceService uses; consistent with the
// PHASE 12a pattern in outbound-sync-phase9.service.ts.
const DEFAULT_HOLD_MS = 5 * 60 * 1000

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
  // CS.1 — channel pushed authoritative stock back; operator
  // (or auto-apply threshold) confirms → snap local to channel.
  | 'CHANNEL_STOCK_RECONCILIATION'

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
  /** L.2: lot reference. When set on a consume (change < 0), the
   *  lot's unitsRemaining is decremented atomically. When set on a
   *  receive (change > 0), the StockMovement row carries the lotId
   *  but the lot's unitsRemaining is NOT incremented (lots track
   *  receives separately via createLot). */
  lotId?: string
  /**
   * P0/B4 — caller's outer transaction. When set, the stock write,
   * StockLevel ledger update, totalStock recompute, ChannelListing
   * cascade, audit row, and OutboundSyncQueue inserts all run in
   * the supplied transaction instead of opening a new one. Mirrors
   * MasterPriceService.update's `ctx.tx` so endpoints that touch
   * basePrice + totalStock + other fields can keep all three writes
   * atomic. The BullMQ post-commit enqueue is suppressed when an
   * outer tx is supplied — the caller is responsible for adding
   * BullMQ jobs after their own commit completes.
   */
  tx?: Prisma.TransactionClient
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
    lotId,
    tx: outerTx,
  } = input
  if (change === 0) throw new Error('applyStockMovement: change must be non-zero')

  // P0/B4 — single transaction body. When the caller supplies an outer
  // tx (e.g. PATCH /api/products/:id wanting basePrice + totalStock +
  // direct-fields atomic) we run inside it; otherwise we open our own.
  // The runner closes over every step including the cascade.
  const runner = async (
    tx: Prisma.TransactionClient,
  ): Promise<{ movement: any; cascade: CascadeResult; stockout: { resolvedLocationId: string; prevAvailable: number; nextAvailable: number } }> => {
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

    // P.1 — ProductVariation writes deprecated. The canonical variant
    // mechanism is Product.parentId; the PV table has zero rows and
    // the wizard / catalog edit paths that produced mirror rows are
    // also disabled in this commit. If a caller still passes a
    // variationId, log a warning so we can find them — but do not
    // attempt the update (would fail since no PV rows exist anyway).
    if (variationId) {
      logger.warn(
        'applyStockMovement: variationId supplied but ProductVariation writes are deprecated (P.1)',
        { productId, variationId, change },
      )
    }

    // Product.totalStock as cached SUM(StockLevel.quantity). Single
    // source of truth across all locations for the H.2 world.
    const newTotalStock = await recomputeProductTotalStock(tx, productId)

    // S.20 — cost-layer hook. Subtractive movements consume layers
    // (FIFO/LIFO/WAC per Product.costingMethod) and capture COGS on
    // the audit row. Additive movements that represent receives
    // create a fresh layer using Product.costPrice as the unit cost
    // (operator can edit later via the drawer). Variant-only paths
    // and pure ledger ops (RESERVATION_*, SYNC_RECONCILIATION,
    // STOCKLEVEL_BACKFILL, PARENT_PRODUCT_CLEANUP) are skipped —
    // they don't represent real receive/consume events.
    let cogsCents: number | null = null
    if (change < 0 && CONSUME_REASONS.has(reason as string)) {
      try {
        const r = await consumeLayersInTx(tx, { productId, units: -change })
        cogsCents = r.cogsCents
      } catch (err) {
        logger.warn('applyStockMovement: cost-layer consume failed (continuing without COGS)', {
          productId, change, reason,
          error: err instanceof Error ? err.message : String(err),
        })
      }
    }

    // T.5 part 1 — stop writing the legacy warehouseId column on new
    // movements. The argument is still accepted (and used above to
    // resolve a StockLocation), but the on-row column is set to NULL
    // so the field can eventually be dropped without a backfill.
    // Historical rows preserve their warehouseId for audit continuity.
    const movement = await tx.stockMovement.create({
      data: {
        productId,
        variationId: variationId ?? null,
        warehouseId: null,
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
        cogsCents,
        // L.2 — lot linkage on the audit row. When change < 0 we ALSO
        // decrement the lot's unitsRemaining below (atomic with the
        // movement insert).
        lotId: lotId ?? null,
      },
    })

    // L.2 — when a consume movement carries a lotId, decrement that
    // lot's unitsRemaining inside the same tx. Throws (rolling back
    // the movement) if the decrement would breach the CHECK or exceed
    // remaining. Receives don't decrement — the lot is created
    // separately via createLot which sets unitsRemaining = unitsReceived.
    if (lotId && change < 0) {
      const { decrementLotInTx } = await import('./lot.service.js')
      await decrementLotInTx(tx, lotId, Math.abs(change))
    }

    // S.20 — receive auto-layer. Fires after the movement row
    // exists so the layer can carry the stockMovementId backref.
    // Cost source: Product.costPrice snapshot at receive time.
    if (change > 0 && RECEIVE_AUTO_LAYER_REASONS.has(reason as string)) {
      try {
        const product = await tx.product.findUnique({
          where: { id: productId },
          select: { costPrice: true },
        })
        const unitCostCents = product?.costPrice == null
          ? 0
          : Math.round(Number(product.costPrice) * 100)
        await receiveLayerInTx(tx, {
          productId,
          variationId: variationId ?? undefined,
          locationId: resolvedLocationId,
          unitsReceived: change,
          unitCostCents,
          stockMovementId: movement.id,
          notes: `auto-layer: ${reason}`,
        })
      } catch (err) {
        logger.warn('applyStockMovement: cost-layer receive failed (continuing)', {
          productId, change, reason,
          error: err instanceof Error ? err.message : String(err),
        })
      }
    }

    // Phase 13 — atomic cascade to ChannelListing.
    //
    // The product's totalStock just changed; every linked ChannelListing
    // needs its masterQuantity snapshot updated, and listings that follow
    // the master need their `quantity` (after stockBuffer subtraction)
    // updated and flagged for marketplace re-push. We do all of this in
    // the same transaction as the stock write — failures roll back the
    // whole movement rather than leaving listings out of date with the
    // ledger. The previous best-effort/swallow approach masked exactly
    // the silent-drift bug TECH_DEBT #42 flagged.
    const cascadeResult = await cascadeQuantityToListings(tx, {
      productId,
      newTotalStock,
      reason,
      change,
      referenceType,
      referenceId,
      actor,
    })

    return {
      movement,
      cascade: cascadeResult,
      // R.12 — stockout transition snapshot for the post-tx hook
      stockout: {
        resolvedLocationId,
        prevAvailable: quantityBefore - reserved,
        nextAvailable: newAvailable,
      },
    }
  }

  // Run inside the caller's tx if supplied; otherwise open our own.
  // When using the outer tx, the BullMQ enqueue is suppressed — the
  // caller is responsible for adding sync jobs after their own
  // commit completes (otherwise we'd post jobs for a transaction
  // that may roll back). Same shape MasterPriceService uses.
  const transactionResult = outerTx
    ? await runner(outerTx)
    : await prisma.$transaction(runner)

  // Step 6: BullMQ enqueue happens AFTER the DB transaction commits. If
  // Redis is down, the OutboundSyncQueue rows stay PENDING and the next
  // drain pass picks them up — work is never lost. Same pattern as
  // MasterPriceService; see master-price.service.ts.
  if (!outerTx && transactionResult.cascade.queuedSyncIds.length > 0) {
    for (const queueId of transactionResult.cascade.queuedSyncIds) {
      try {
        await outboundSyncQueue.add(
          'sync-job',
          {
            queueId,
            productId,
            syncType: 'QUANTITY_UPDATE',
            source: 'STOCK_MOVEMENT',
            reason,
          },
          {
            delay: DEFAULT_HOLD_MS,
            jobId: queueId,
          },
        )
      } catch (err) {
        logger.warn(
          'applyStockMovement: BullMQ enqueue failed (DB row remains PENDING for next drain)',
          {
            queueId,
            productId,
            err: err instanceof Error ? err.message : String(err),
          },
        )
      }
    }
  }

  // R.12 — stockout detection hook. Runs AFTER the transaction
  // commits so we don't open events for movements that get rolled
  // back. Failures must not block the movement; logged + ignored.
  if (!outerTx) {
    try {
      const product = await prisma.product.findUnique({
        where: { id: productId },
        select: { sku: true },
      })
      if (product) {
        await handleMovementStockoutTransition({
          productId,
          sku: product.sku,
          locationId: transactionResult.stockout.resolvedLocationId,
          prevAvailable: transactionResult.stockout.prevAvailable,
          nextAvailable: transactionResult.stockout.nextAvailable,
        })
      }
    } catch (err) {
      logger.warn('applyStockMovement: stockout hook failed', {
        productId,
        err: err instanceof Error ? err.message : String(err),
      })
    }
  }

  return transactionResult.movement
}

interface CascadeArgs {
  productId: string
  newTotalStock: number
  reason: MovementReason
  change: number
  referenceType?: string
  referenceId?: string
  actor?: string
}

interface CascadeResult {
  cascadedListingIds: string[]
  snapshottedListingIds: string[]
  queuedSyncIds: string[]
}

/**
 * Cascade a new totalStock value to every ChannelListing linked to the
 * product. Mirrors MasterPriceService.computeListingPrice / cascade —
 * runs inside the caller's transaction.
 *
 * Cascade rules:
 *   masterQuantity := newTotalStock         (always — drift snapshot)
 *   if followMasterQuantity = true:
 *      newListingQty := max(0, newTotalStock - stockBuffer)
 *      if newListingQty != current listing.quantity:
 *         update listing.quantity + lastSyncStatus=PENDING
 *         enqueue OutboundSyncQueue (syncType='QUANTITY_UPDATE')
 *
 * The ['AMAZON','EBAY','SHOPIFY','WOOCOMMERCE'] gate matches the
 * SyncChannel enum's accepted values for OutboundSyncQueue.targetChannel —
 * unknown channels are skipped (we still snapshot masterQuantity for them
 * but don't enqueue a marketplace push).
 */
async function cascadeQuantityToListings(
  tx: Prisma.TransactionClient,
  args: CascadeArgs,
): Promise<CascadeResult> {
  const { productId, newTotalStock, reason, change, referenceType, referenceId } = args

  const listings = await tx.channelListing.findMany({
    where: { productId },
    select: {
      id: true,
      channel: true,
      region: true,
      marketplace: true,
      externalListingId: true,
      quantity: true,
      masterQuantity: true,
      stockBuffer: true,
      followMasterQuantity: true,
    },
  })

  const cascadedListingIds: string[] = []
  const snapshottedListingIds: string[] = []
  const queueRowsToCreate: Prisma.OutboundSyncQueueCreateManyInput[] = []
  const validTargets = new Set(['AMAZON', 'EBAY', 'SHOPIFY', 'WOOCOMMERCE'])
  const holdUntil = new Date(Date.now() + DEFAULT_HOLD_MS)

  for (const listing of listings) {
    const newListingQty = listing.followMasterQuantity
      ? Math.max(0, newTotalStock - (listing.stockBuffer ?? 0))
      : null

    if (newListingQty != null && newListingQty !== listing.quantity) {
      await tx.channelListing.update({
        where: { id: listing.id },
        data: {
          masterQuantity: newTotalStock,
          quantity: newListingQty,
          lastSyncStatus: 'PENDING',
          lastSyncedAt: null,
          version: { increment: 1 },
        },
      })
      cascadedListingIds.push(listing.id)
      if (validTargets.has(listing.channel)) {
        queueRowsToCreate.push({
          productId,
          channelListingId: listing.id,
          targetChannel: listing.channel as any,
          targetRegion: listing.region,
          syncStatus: 'PENDING' as any,
          syncType: 'QUANTITY_UPDATE',
          holdUntil,
          externalListingId: listing.externalListingId,
          maxRetries: 3,
          payload: {
            source: 'STOCK_MOVEMENT',
            productId,
            channel: listing.channel,
            marketplace: listing.marketplace,
            quantity: newListingQty,
            oldQuantity: listing.quantity,
            masterQuantity: newTotalStock,
            stockBuffer: listing.stockBuffer ?? 0,
            reason,
            change,
            referenceType: referenceType ?? null,
            referenceId: referenceId ?? null,
          },
        })
      }
    } else {
      // Snapshot-only path. Either followMasterQuantity=false (drift
      // signal preserved) or computed quantity equals existing (no-op).
      if (listing.masterQuantity !== newTotalStock) {
        await tx.channelListing.update({
          where: { id: listing.id },
          data: { masterQuantity: newTotalStock },
        })
      }
      snapshottedListingIds.push(listing.id)
    }
  }

  let queuedSyncIds: string[] = []
  if (queueRowsToCreate.length > 0) {
    await tx.outboundSyncQueue.createMany({ data: queueRowsToCreate })
    const justEnqueued = await tx.outboundSyncQueue.findMany({
      where: {
        channelListingId: { in: cascadedListingIds },
        syncType: 'QUANTITY_UPDATE',
        syncStatus: 'PENDING',
      },
      orderBy: { createdAt: 'desc' },
      take: cascadedListingIds.length,
      select: { id: true },
    })
    queuedSyncIds = justEnqueued.map((r) => r.id)
  }

  return { cascadedListingIds, snapshottedListingIds, queuedSyncIds }
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
  /** Legacy filter — still supported via StockLocation.warehouseId
   *  join so historical + new rows are both visible. T.5 will drop
   *  the column eventually. */
  warehouseId?: string
  limit?: number
  before?: Date
}) {
  const where: any = {}
  if (opts.productId) where.productId = opts.productId
  if (opts.variationId) where.variationId = opts.variationId
  if (opts.warehouseId) {
    // T.5 part 1 — match either the legacy column (old rows) OR a
    // current location whose StockLocation.warehouseId matches (new
    // rows that no longer write the column directly).
    where.OR = [
      { warehouseId: opts.warehouseId },
      { location: { warehouseId: opts.warehouseId } },
    ]
  }
  if (opts.before) where.createdAt = { lt: opts.before }

  return prisma.stockMovement.findMany({
    where,
    orderBy: { createdAt: 'desc' },
    take: Math.min(500, opts.limit ?? 100),
  })
}
