// apps/api/src/services/ebay-shared-fanout.service.ts
//
// Phase 3 — builds OutboundSyncQueue create-inputs that fan a shared variant
// SKU's quantity out to every eBay listing (ItemID) containing it. Tagged
// payload.pushVia:'TRADING' so the existing OutboundSyncService.syncToEbay
// worker routes them through Phase-1 reviseInventoryStatus instead of the
// Inventory-API path. Pure + side-effect-free so it is unit-testable without
// the stock transaction or the network.

import { computeAvailableToPublish } from './available-to-publish.service.js'

export interface SharedMembershipRow {
  sku: string
  itemId: string
  marketplace: string // 'IT'|'DE'|'FR'|'ES'|'UK'
  productId: string | null
}

/** marketplace 2-letter -> eBay marketplaceId form used for logging/circuit/rate-limit. */
export function ebayMarketplaceIdForMarket(market: string): string {
  const m = (market ?? '').toUpperCase()
  return m === 'UK' ? 'EBAY_GB' : `EBAY_${m}`
}

export interface SharedFanoutPayload {
  source: 'STOCK_MOVEMENT_SHARED'
  pushVia: 'TRADING'
  sku: string
  itemId: string
  market: string         // 2-letter, for reviseInventoryStatus
  marketplaceId: string  // 'EBAY_xx', for logging/circuit/rate-limit
  quantity: number
  oldQuantity: number | null
  productId: string | null
}

export interface SharedFanoutRow {
  productId: string | null
  channelListingId: null
  targetChannel: 'EBAY'
  targetRegion: string   // the 2-letter market
  syncStatus: 'PENDING'
  syncType: 'QUANTITY_UPDATE'
  holdUntil: Date
  externalListingId: string // = itemId
  maxRetries: number
  payload: SharedFanoutPayload
}

/**
 * Pure builder: one OutboundSyncQueue create-input per membership.
 * `cappedQtyFor(m)` returns the already-pool-capped quantity for that membership
 * (caller computes it from warehouse-available − buffer); rows whose qty equals
 * `lastQtyPushed` (passed per row) are dropped as no-ops.
 */
export function buildSharedFanoutRows(
  memberships: Array<SharedMembershipRow & { lastQtyPushed: number | null }>,
  cappedQtyFor: (m: SharedMembershipRow) => number,
  holdUntil: Date,
): SharedFanoutRow[] {
  const rows: SharedFanoutRow[] = []
  for (const m of memberships) {
    const quantity = Math.max(0, Math.trunc(cappedQtyFor(m)))
    if (m.lastQtyPushed != null && quantity === m.lastQtyPushed) continue // no-op
    rows.push({
      productId: m.productId,
      channelListingId: null,
      targetChannel: 'EBAY',
      targetRegion: m.marketplace,
      syncStatus: 'PENDING',
      syncType: 'QUANTITY_UPDATE',
      holdUntil,
      externalListingId: m.itemId,
      maxRetries: 3,
      payload: {
        source: 'STOCK_MOVEMENT_SHARED',
        pushVia: 'TRADING',
        sku: m.sku,
        itemId: m.itemId,
        market: m.marketplace,
        marketplaceId: ebayMarketplaceIdForMarket(m.marketplace),
        quantity,
        oldQuantity: m.lastQtyPushed,
        productId: m.productId,
      },
    })
  }
  return rows
}

// ── Task 2: enqueueSharedTradingFanout ──────────────────────────────────────

export interface SharedFanoutDeps {
  sharedListingMembership: { findMany: Function }
  outboundSyncQueue: { createMany: Function; findMany: Function }
}

export interface SharedFanoutArgs {
  productId: string
  /** Reserved-adjusted own-warehouse available for this product (cascade already
   *  computed it — pass it straight through). */
  warehouseAvailable: number
  /** Overselling buffer to subtract (the cascade reads ChannelListing.stockBuffer;
   *  shared listings have no ChannelListing, so default 0 unless a future per-SKU
   *  buffer exists). */
  stockBuffer?: number
  holdUntil: Date
  /** Optional: restrict to a single changed SKU (else all of the product's
   *  memberships re-push). */
  sku?: string
}

/** Returns the OutboundSyncQueue ids enqueued (so the caller adds BullMQ jobs). */
export async function enqueueSharedTradingFanout(
  db: SharedFanoutDeps,
  args: SharedFanoutArgs,
): Promise<string[]> {
  const where: Record<string, unknown> = { productId: args.productId, status: 'ACTIVE' }
  if (args.sku) where.sku = args.sku

  const memberships = (await db.sharedListingMembership.findMany({
    where,
    select: { sku: true, itemId: true, marketplace: true, productId: true, lastQtyPushed: true },
  })) as Array<SharedMembershipRow & { lastQtyPushed: number | null }>

  if (memberships.length === 0) return []

  const capped = computeAvailableToPublish({
    fulfillmentMethod: 'FBM',
    warehouseAvailable: args.warehouseAvailable,
    fbaSellable: 0,
    stockBuffer: args.stockBuffer ?? 0,
  }).available

  const rows = buildSharedFanoutRows(memberships, () => capped, args.holdUntil)
  if (rows.length === 0) return []

  await db.outboundSyncQueue.createMany({ data: rows })

  // Re-read the rows we just enqueued so we can return their DB ids to the
  // caller for BullMQ dispatch.
  // `channelListingId: null` is essential: the same transaction may have also
  // enqueued ChannelListing rows for this product; keeping this scope to null
  // isolates the shared-SKU rows and prevents id collisions.
  // A same-millisecond `createdAt` tie across rows is harmless — BullMQ
  // deduplicates by jobId and the push is idempotent; the backstop drain
  // heals any row that is missed here.
  const justEnqueued = (await db.outboundSyncQueue.findMany({
    where: {
      productId: args.productId,
      channelListingId: null,
      syncType: 'QUANTITY_UPDATE',
      syncStatus: 'PENDING',
    },
    orderBy: { createdAt: 'desc' },
    take: rows.length,
    select: { id: true },
  })) as Array<{ id: string }>

  return justEnqueued.map((r) => r.id)
}
