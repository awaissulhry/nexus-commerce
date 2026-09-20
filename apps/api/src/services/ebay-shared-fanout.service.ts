// apps/api/src/services/ebay-shared-fanout.service.ts
//
// Phase 3 — builds OutboundSyncQueue create-inputs that fan a shared variant
// SKU's quantity out to every eBay listing (ItemID) containing it. Tagged
// payload.pushVia:'TRADING' so the existing OutboundSyncService.syncToEbay
// worker routes them through Phase-1 reviseInventoryStatus instead of the
// Inventory-API path. Pure + side-effect-free so it is unit-testable without
// the stock transaction or the network.

import { createOutboundRows } from './outbound-rows.js'
// Shared stock — the fan-out reads ONE ledger (loadSyncLedgers), which knows a pooled product's pool.
import { resolveMembershipIntended, type SyncLedger } from './sync-control-core.js'
import { coalescePendingSharedQuantityRows } from './sync-coalesce.js'
import { policyFor, type PolicyMap } from './sync-control-policy.service.js'

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

export interface SharedFanoutUpdate {
  sku: string
  quantity: number
  oldQuantity: number | null
}

export interface SharedFanoutPayload {
  source: 'STOCK_MOVEMENT_SHARED'
  pushVia: 'TRADING'
  itemId: string
  market: string         // 2-letter, for reviseInventoryStatus
  marketplaceId: string  // 'EBAY_xx', for logging/circuit/rate-limit
  productId: string | null
  /** RT.2 — ALL changed SKUs for this ItemID in one row. The dispatcher
   *  chunks these ≤4 per ReviseInventoryStatus call. One pool change on a
   *  40-variation listing = 1 row / 10 Trading calls instead of 40 rows /
   *  40 calls — essential under eBay's ~250 revises/listing/DAY cap. */
  updates: SharedFanoutUpdate[]
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
 * Pure builder: one OutboundSyncQueue create-input per ITEM ID (RT.2 —
 * was one per membership). `cappedQtyFor(m)` returns the already-pool-capped
 * quantity for that membership; SKUs whose qty equals `lastQtyPushed` are
 * dropped as no-ops, and items with zero changed SKUs emit no row at all.
 */
export function buildSharedFanoutRows(
  memberships: Array<SharedMembershipRow & { lastQtyPushed: number | null }>,
  cappedQtyFor: (m: SharedMembershipRow) => number,
  holdUntil: Date,
): SharedFanoutRow[] {
  const byItem = new Map<string, Array<SharedMembershipRow & { lastQtyPushed: number | null }>>()
  for (const m of memberships) {
    const list = byItem.get(m.itemId)
    if (list) list.push(m)
    else byItem.set(m.itemId, [m])
  }

  const rows: SharedFanoutRow[] = []
  for (const [itemId, members] of byItem) {
    const updates: SharedFanoutUpdate[] = []
    for (const m of members) {
      const quantity = Math.max(0, Math.trunc(cappedQtyFor(m)))
      if (m.lastQtyPushed != null && quantity === m.lastQtyPushed) continue // no-op
      updates.push({ sku: m.sku, quantity, oldQuantity: m.lastQtyPushed })
    }
    if (updates.length === 0) continue
    const first = members[0]
    rows.push({
      productId: first.productId,
      channelListingId: null,
      targetChannel: 'EBAY',
      targetRegion: first.marketplace,
      syncStatus: 'PENDING',
      syncType: 'QUANTITY_UPDATE',
      holdUntil,
      externalListingId: itemId,
      maxRetries: 3,
      payload: {
        source: 'STOCK_MOVEMENT_SHARED',
        pushVia: 'TRADING',
        itemId,
        market: first.marketplace,
        marketplaceId: ebayMarketplaceIdForMarket(first.marketplace),
        productId: first.productId,
        updates,
      },
    })
  }
  return rows
}

// ── Task 2: enqueueSharedTradingFanout ──────────────────────────────────────

export interface SharedFanoutDeps {
  sharedListingMembership: { findMany: Function }
  // P4.3e — `updateMany` is how superseded rows are coalesced before the fresh
  // ones are written. Both callers pass a Prisma client or transaction, which
  // has it; a test double must declare it so the coalesce cannot be skipped by
  // a narrow mock and read as "nothing to cancel".
  outboundSyncQueue: { createMany: Function; findMany: Function; updateMany: Function }
}

export interface SharedFanoutArgs {
  productId: string
  holdUntil: Date
  /** Optional: restrict to a single changed SKU (else all of the product's
   *  memberships re-push). */
  sku?: string
  /** SC.1 — quantities derive PER MEMBERSHIP via the sync-control core (routing + followPool +
   *  per-membership buffer); PAUSED and UNCOUNTED members are excluded from the fan-out entirely.
   *  From loadSyncLedgers (shared stock), so a pooled product fans out the pool's number. */
  scLedger: SyncLedger
  /** Shared stock — the product left a pool: an uncounted own stock means 0 (loadSyncLedgers). */
  uncountedIsZero?: boolean
  scPolicies?: PolicyMap
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
    select: {
      sku: true, itemId: true, marketplace: true, productId: true, lastQtyPushed: true,
      followPool: true, stockBuffer: true, pinnedQuantity: true,
    },
  })) as Array<SharedMembershipRow & { lastQtyPushed: number | null; followPool?: boolean; stockBuffer?: number; pinnedQuantity?: number | null }>

  if (memberships.length === 0) return []

  // SC.1 — per-membership derivation. followPool=false (PAUSED) and routed-UNCOUNTED members never
  // receive a push from this fan-out. A fixed number (shared stock step 3) is pushed until the variant
  // shows it, then skipped like any variant already at its number. (Shared stock: the one path — the uniform capped number that
  // ignored Excluded members and the pool is gone; every caller passes the loader's ledger.)
  const resolvedQty = new Map<string, number>()
  const eligible = memberships.filter((m) => {
    const r = resolveMembershipIntended({
      marketplace: m.marketplace,
      followPool: m.followPool ?? true,
      pinnedQuantity: m.pinnedQuantity ?? null,
      stockBuffer: m.stockBuffer ?? 0,
      channelPolicy: args.scPolicies ? policyFor(args.scPolicies, 'EBAY', m.marketplace) : null,
      ledger: args.scLedger,
      uncountedIsZero: args.uncountedIsZero,
    })
    if (r.kind === 'PINNED' && r.quantity != null) {
      resolvedQty.set(`${m.itemId} ${m.sku}`, r.quantity)
      return true
    }
    if (r.kind !== 'FOLLOW') return false
    resolvedQty.set(`${m.itemId} ${m.sku}`, r.quantity)
    return true
  })
  const qtyFor = (m: SharedMembershipRow) => resolvedQty.get(`${m.itemId} ${m.sku}`) ?? 0

  const rows = buildSharedFanoutRows(eligible, qtyFor, args.holdUntil)
  if (rows.length === 0) return []

  // P4.3e — cancel this product's superseded PENDING rows for exactly the
  // ItemIDs we are about to replace, in the SAME transaction as the insert, so
  // an older snapshot cannot dispatch after the new value. The ChannelListing
  // lane has done this since P1; this lane never did.
  //
  // 🔴 Skipped when `args.sku` narrowed the run: it then covers only that SKU's
  // memberships, so its rows cannot claim to supersede a pending row that may
  // carry the product's other SKUs. Neither caller sets `args.sku` today.
  // Kill-switch: NEXUS_SYNC_ORDERING_V2=0, the same one the sibling uses.
  if (process.env.NEXUS_SYNC_ORDERING_V2 !== '0' && !args.sku) {
    await coalescePendingSharedQuantityRows(db as never, args.productId, rows.map((r) => r.externalListingId))
  }

  await createOutboundRows(db, { data: rows as never }) // SharedFanoutRow is the createMany input (its payload type has no index signature)

  // Re-read the rows we just enqueued so we can return their DB ids to the
  // caller for BullMQ dispatch.
  // `channelListingId: null` is essential: the same transaction may have also
  // enqueued ChannelListing rows for this product; keeping this scope to null
  // isolates the shared-SKU rows and prevents id collisions.
  // P4.3e — and since the coalesce above cancelled this product's older PENDING
  // shared rows first, the rows this reads back ARE the rows just written. The
  // `createdAt` ordering used to be the only thing separating them from a
  // superseded row sitting in the same scope.
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
