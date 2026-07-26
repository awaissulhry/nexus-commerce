/**
 * Follow-Master quantity primitive (Phase 0 of the per-market inventory control
 * plan, docs/superpowers/plans/2026-07-08-follow-master-bulk-tool.md).
 *
 * Sets a set of ChannelListings to FOLLOW the shared warehouse pool or to PIN a
 * fixed per-market quantity — per (product × channel × market).
 *
 * Two hard invariants, enforced here:
 *   A. NEVER writes StockLevel / Product.totalStock — only per-listing columns.
 *      (The AIRMESH clobber came from a flat-file save writing the pool.)
 *   B. NEVER touches an Amazon FBA listing's quantity — FBA is Amazon-managed.
 *      FBA listings are skipped fail-closed via isFbaListing(). The push layer
 *      (buildAmazonListingPatch) is the final backstop and is untouched.
 *
 * Correct write shape (the "column hazard": different push paths read different
 * quantity columns, so we write all three coherently):
 *   FOLLOW: { followMasterQuantity: true,  quantityOverride: null, quantity: poolAvailable }
 *   PIN:    { followMasterQuantity: false, quantityOverride: v,    quantity: v }   (v = snapshot)
 * Then enqueue a QUANTITY_UPDATE so the marketplace reflects it. Mirrors the
 * proven stock-import pinOverride path.
 */

import prisma from '../db.js'
import { computeAvailableToPublish } from './available-to-publish.service.js'
import { isFbaListing } from './outbound-sync.service.js'
import { coalescePendingQuantityRows } from './sync-coalesce.js'
import { outboundSyncQueue, addJobSafely } from '../lib/queue.js'
import { logger } from '../utils/logger.js'

const FOLLOW_HOLD_MS = 30 * 1000

/** P2028 guard — bulk calls run MANY SMALL transactions, never one giant one.
 *  The single interactive tx timed out above ~10 products (first hit in
 *  RT.5.1, 2026-07-20, worked around only in the calling script; the Sync
 *  Control 500/page bulk UI then handed this service hundreds of targets and
 *  every large FOLLOW/PIN died with a bare 500). 25 rows × ~2 queries ≈ 50
 *  round-trips per tx — far inside the explicit 15s ceiling. */
const BULK_TX_CHUNK = 25
const BULK_TX_OPTS = { timeout: 15_000, maxWait: 5_000 }
const VALID_SYNC_TARGETS = new Set(['AMAZON', 'EBAY', 'SHOPIFY', 'WOOCOMMERCE'])

export type FollowMasterChannel = 'AMAZON' | 'EBAY'

export interface FollowMasterWrite {
  quantity: number
  quantityOverride: number | null
  followMasterQuantity: boolean
}

/**
 * PURE — the exact per-listing column write for a follow/pin. Unit-tested.
 *  - follow=true  → rejoin the pool: clear the override, publish pool-available.
 *  - follow=false → pin: snapshot the current effective quantity into ALL
 *    quantity columns so every push path agrees. Nothing changes at pin time.
 */
export function computeFollowMasterWrite(
  listing: { quantity: number | null; quantityOverride: number | null },
  follow: boolean,
  poolAvailable: number,
): FollowMasterWrite {
  if (follow) {
    return { quantity: Math.max(0, poolAvailable), quantityOverride: null, followMasterQuantity: true }
  }
  // Pin: snapshot the current effective PUBLISHED quantity. Prefer base
  // `quantity` (what the operator sees + what most push paths send, and — in the
  // save flow — the value the flat-file save just wrote) over a possibly-stale
  // `quantityOverride`. Fall back to override, then pool-available.
  const v = Math.max(0, listing.quantity ?? listing.quantityOverride ?? poolAvailable)
  return { quantity: v, quantityOverride: v, followMasterQuantity: false }
}

/** True when the listing already matches the desired write (nothing to do). */
function isNoOp(
  current: { followMasterQuantity: boolean | null; quantityOverride: number | null; quantity: number | null },
  write: FollowMasterWrite,
): boolean {
  const currentFollow = current.followMasterQuantity !== false
  return (
    currentFollow === write.followMasterQuantity &&
    current.quantityOverride === write.quantityOverride &&
    current.quantity === write.quantity
  )
}

export interface FollowMasterResult {
  updated: number
  skippedFba: number
  unchanged: number
  matched: number
  /** Set when a mid-bulk chunk failed AFTER earlier chunks committed: the
   *  message of the failure. Committed chunks stand (idempotent re-run
   *  continues). A FIRST-chunk failure throws instead — nothing was written. */
  error?: string
  /** Rows not attempted because a chunk failed (see error). */
  remaining?: number
  results: Array<{
    listingId: string
    sku: string | null
    channel: string
    marketplace: string
    action: 'FOLLOW' | 'PIN' | 'SKIPPED_FBA' | 'UNCHANGED'
    quantity: number | null
  }>
}

export interface FollowMasterOpts {
  productIds: string[]
  channel: FollowMasterChannel
  markets: string[] | 'ALL'
  follow: boolean
  actor?: string
}

export async function setFollowMasterQuantity(opts: FollowMasterOpts): Promise<FollowMasterResult> {
  const { productIds, channel, follow, actor } = opts
  const result: FollowMasterResult = { updated: 0, skippedFba: 0, unchanged: 0, matched: 0, results: [] }
  if (productIds.length === 0) return result

  // Resolve the exact listings by (productId, channel, marketplace).
  const listings = await prisma.channelListing.findMany({
    where: {
      productId: { in: productIds },
      channel,
      ...(opts.markets === 'ALL' ? {} : { marketplace: { in: opts.markets } }),
      listingStatus: { not: 'ENDED' },
    },
    select: {
      id: true, productId: true, channel: true, region: true, marketplace: true,
      quantity: true, quantityOverride: true, followMasterQuantity: true, stockBuffer: true,
      externalListingId: true, fulfillmentMethod: true, platformAttributes: true,
      product: { select: { sku: true, fulfillmentMethod: true } },
    },
  })
  result.matched = listings.length
  if (listings.length === 0) return result

  // Per-product warehouse-available (for the FOLLOW recompute) + FBA stock
  // (fail-closed FBA evidence). READ-ONLY — StockLevel is never written here.
  const stockRows = await prisma.stockLevel.findMany({
    where: { productId: { in: productIds } },
    select: { productId: true, available: true, quantity: true, location: { select: { type: true } } },
  })
  const warehouseAvailByProduct = new Map<string, number>()
  const fbaQtyByProduct = new Map<string, number>()
  for (const s of stockRows) {
    if (s.location?.type === 'WAREHOUSE') {
      warehouseAvailByProduct.set(s.productId, (warehouseAvailByProduct.get(s.productId) ?? 0) + s.available)
    } else if (s.location?.type === 'AMAZON_FBA') {
      fbaQtyByProduct.set(s.productId, (fbaQtyByProduct.get(s.productId) ?? 0) + s.quantity)
    }
  }

  const applicable = listings.filter((cl) => {
    // Invariant B: skip FBA (fail-closed — any FBA signal ⇒ leave it alone).
    // FBA only exists on AMAZON; eBay/Shopify/Woo are always merchant-fulfilled
    // (FBM), so the product's Amazon-FBA status must NOT skip a non-Amazon listing.
    const fba = cl.channel === 'AMAZON' && isFbaListing(
      { fulfillmentMethod: cl.fulfillmentMethod, platformAttributes: cl.platformAttributes },
      { fulfillmentMethod: cl.product?.fulfillmentMethod },
      { fbaStockQty: fbaQtyByProduct.get(cl.productId) ?? 0 },
    )
    if (fba) {
      result.skippedFba++
      result.results.push({ listingId: cl.id, sku: cl.product?.sku ?? null, channel: cl.channel, marketplace: cl.marketplace, action: 'SKIPPED_FBA', quantity: null })
    }
    return !fba
  })

  if (applicable.length === 0) return result

  // Chunked transactions (P2028 fix — see BULK_TX_CHUNK). Each chunk commits
  // atomically; counts/queue-follow-ups are merged only AFTER a chunk commits,
  // so a rolled-back chunk can never inflate the response or enqueue a BullMQ
  // job for a queue row that no longer exists. NEVER touches StockLevel/totalStock.
  const queued: Array<{ queueId: string; productId: string }> = []
  let processed = 0
  for (let i = 0; i < applicable.length; i += BULK_TX_CHUNK) {
    const chunk = applicable.slice(i, i + BULK_TX_CHUNK)
    // Chunk-local accumulators — merged into result ONLY on commit.
    const acc = {
      updated: 0,
      unchanged: 0,
      results: [] as FollowMasterResult['results'],
      queued: [] as Array<{ queueId: string; productId: string }>,
    }
    try {
      await prisma.$transaction(async (tx) => {
        acc.updated = 0; acc.unchanged = 0; acc.results.length = 0; acc.queued.length = 0
        const holdUntil = new Date(Date.now() + FOLLOW_HOLD_MS)
        // FB-S4 — re-read stockBuffer INSIDE the tx (a concurrent bulk-buffer
        // write must win), but in ONE query for the whole chunk: the per-row
        // findUnique here is exactly what pushed the old giant tx past the 5s
        // interactive-transaction timeout.
        const freshBuffers = new Map<string, number | null>(
          (
            await tx.channelListing.findMany({
              where: { id: { in: chunk.map((c) => c.id) } },
              select: { id: true, stockBuffer: true },
            })
          ).map((r) => [r.id, r.stockBuffer]),
        )
        // Same freshness rule for the POOL: a late chunk must not write a
        // request-start snapshot — a sale mid-bulk would have its cascade row
        // coalesced away and replaced with a STALE quantity. One query/chunk.
        const chunkPids = [...new Set(chunk.map((c) => c.productId))]
        const freshStock = await tx.stockLevel.findMany({
          where: { productId: { in: chunkPids }, location: { type: 'WAREHOUSE' } },
          select: { productId: true, available: true },
        })
        const freshAvail = new Map<string, number>()
        for (const st of freshStock) freshAvail.set(st.productId, (freshAvail.get(st.productId) ?? 0) + st.available)
        // Compute EVERY row's write first, then coalesce ONLY the rows that
        // will actually change. Coalescing the whole chunk cancelled the
        // pending pushes of NO-OP rows without enqueuing a replacement — which
        // both dropped fresher concurrent cascade rows and broke the partial
        // "re-run to continue" promise (the re-run's no-ops silently killed
        // the first run's still-pending pushes).
        const plans = chunk.map((cl) => {
          const warehouseAvailable = freshAvail.get(cl.productId) ?? 0
          const freshBuffer = freshBuffers.get(cl.id) ?? cl.stockBuffer ?? 0
          const poolAvailable = computeAvailableToPublish({
            fulfillmentMethod: 'FBM',
            warehouseAvailable,
            fbaSellable: 0,
            stockBuffer: freshBuffer,
          }).available
          const write = computeFollowMasterWrite(cl, follow, poolAvailable)
          return { cl, write, noOp: isNoOp(cl, write) }
        })
        const writeIds = plans.filter((p) => !p.noOp).map((p) => p.cl.id)
        if (writeIds.length) await coalescePendingQuantityRows(tx, writeIds)

        for (const { cl, write, noOp } of plans) {
          // Skip true no-ops so a routine save never fires a needless push.
          if (noOp) {
            acc.unchanged++
            acc.results.push({
              listingId: cl.id, sku: cl.product?.sku ?? null, channel: cl.channel,
              marketplace: cl.marketplace, action: 'UNCHANGED', quantity: write.quantity,
            })
            continue
          }

          await tx.channelListing.update({
            where: { id: cl.id },
            data: {
              quantity: write.quantity,
              quantityOverride: write.quantityOverride,
              followMasterQuantity: write.followMasterQuantity,
              lastSyncStatus: 'PENDING',
              lastSyncedAt: null,
              // Deliberately NOT bumping `version`. In the flat-file save flow this
              // endpoint runs immediately AFTER the content save (sync-rows), which owns
              // the optimistic-concurrency `version` the grid tracks and returns. Bumping
              // here would desync the grid's _version, so the operator's NEXT save of the
              // same row would fail Amazon's version check ("Changed elsewhere…") and drop
              // their content edit. This write is coherent with the content save, so the
              // content save's version bump is sufficient.
            },
          })
          acc.updated++
          acc.results.push({
            listingId: cl.id, sku: cl.product?.sku ?? null, channel: cl.channel,
            marketplace: cl.marketplace, action: follow ? 'FOLLOW' : 'PIN', quantity: write.quantity,
          })

          if (VALID_SYNC_TARGETS.has(cl.channel)) {
            const qRow = await tx.outboundSyncQueue.create({
              data: {
                productId: cl.productId,
                channelListingId: cl.id,
                targetChannel: cl.channel as any,
                targetRegion: cl.region,
                syncStatus: 'PENDING' as any,
                syncType: 'QUANTITY_UPDATE',
                holdUntil,
                externalListingId: cl.externalListingId,
                maxRetries: 3,
                payload: {
                  source: 'FOLLOW_MASTER',
                  productId: cl.productId,
                  channel: cl.channel,
                  marketplace: cl.marketplace,
                  quantity: write.quantity,
                  oldQuantity: cl.quantity,
                  follow,
                  actor: actor ?? null,
                },
              },
              select: { id: true },
            })
            acc.queued.push({ queueId: qRow.id, productId: cl.productId })
          }
        }
      }, BULK_TX_OPTS)
      // Commit succeeded — NOW the chunk's work is real.
      result.updated += acc.updated
      result.unchanged += acc.unchanged
      result.results.push(...acc.results)
      queued.push(...acc.queued)
      processed += chunk.length
    } catch (e) {
      // First chunk failing = nothing written → clean throw (small callers,
      // e.g. the flat-file save flow, keep their existing failure semantics).
      if (processed === 0) throw e
      result.error = e instanceof Error ? e.message : String(e)
      result.remaining = applicable.length - processed
      logger.error('follow-master: bulk stopped mid-way', {
        channel, follow, processed, remaining: result.remaining, error: result.error,
      })
      break
    }
  }

  // Enqueue BullMQ jobs AFTER commit (bounded + circuit-broken; a dropped add
  // just leaves the DB row PENDING for the drain cron).
  for (const { queueId, productId } of queued) {
    await addJobSafely(
      outboundSyncQueue,
      'sync-job',
      { queueId, productId, syncType: 'QUANTITY_UPDATE', source: 'FOLLOW_MASTER' },
      { delay: FOLLOW_HOLD_MS, jobId: queueId },
    )
  }

  logger.info('follow-master: applied', {
    channel, follow, updated: result.updated, skippedFba: result.skippedFba, matched: result.matched, actor: actor ?? null,
  })
  return result
}

// ── Stock buffer (Phase 4) ──────────────────────────────────────────────────
// Sets ChannelListing.stockBuffer per (product × channel × market). A FOLLOWING
// listing then republishes pool−buffer (computeAvailableToPublish subtracts it);
// a PINNED listing just stores the buffer — its fixed quantity is untouched, since
// a buffer only shapes what a following listing exposes. Same invariants as follow:
// never writes StockLevel/totalStock, skips FBA fail-closed, no version bump.

export interface StockBufferWrite {
  stockBuffer: number
  quantity: number
  quantityOverride: number | null
  followMasterQuantity: boolean
  /** Non-null only when a FOLLOWING listing's published quantity moved → push it. */
  pushQuantity: number | null
}

/** PURE — the per-listing write for a stock-buffer change. Unit-tested. */
export function computeStockBufferWrite(
  listing: { quantity: number | null; quantityOverride: number | null; followMasterQuantity: boolean | null; stockBuffer: number | null },
  buffer: number,
  warehouseAvailable: number,
): StockBufferWrite {
  const b = Math.max(0, Math.floor(buffer || 0))
  const following = listing.followMasterQuantity !== false
  if (following) {
    const poolAvailable = computeAvailableToPublish({
      fulfillmentMethod: 'FBM', warehouseAvailable, fbaSellable: 0, stockBuffer: b,
    }).available
    return { stockBuffer: b, quantity: poolAvailable, quantityOverride: null, followMasterQuantity: true, pushQuantity: poolAvailable }
  }
  return { stockBuffer: b, quantity: listing.quantity ?? 0, quantityOverride: listing.quantityOverride ?? null, followMasterQuantity: false, pushQuantity: null }
}

function isBufferNoOp(
  current: { stockBuffer: number | null; quantity: number | null; quantityOverride: number | null; followMasterQuantity: boolean | null },
  write: StockBufferWrite,
): boolean {
  return (
    (current.stockBuffer ?? 0) === write.stockBuffer &&
    current.quantity === write.quantity &&
    current.quantityOverride === write.quantityOverride &&
    (current.followMasterQuantity !== false) === write.followMasterQuantity
  )
}

export interface StockBufferResult {
  updated: number
  skippedFba: number
  unchanged: number
  matched: number
  /** Same partial-failure contract as FollowMasterResult. */
  error?: string
  remaining?: number
  results: Array<{
    listingId: string; sku: string | null; channel: string; marketplace: string
    action: 'BUFFER' | 'SKIPPED_FBA' | 'UNCHANGED'; buffer: number; quantity: number | null
  }>
}

export interface StockBufferOpts {
  productIds: string[]
  channel: FollowMasterChannel
  markets: string[] | 'ALL'
  buffer: number
  actor?: string
}

export async function setStockBuffer(opts: StockBufferOpts): Promise<StockBufferResult> {
  const { productIds, channel, buffer, actor } = opts
  const result: StockBufferResult = { updated: 0, skippedFba: 0, unchanged: 0, matched: 0, results: [] }
  if (productIds.length === 0) return result

  const listings = await prisma.channelListing.findMany({
    where: {
      productId: { in: productIds },
      channel,
      ...(opts.markets === 'ALL' ? {} : { marketplace: { in: opts.markets } }),
      listingStatus: { not: 'ENDED' },
    },
    select: {
      id: true, productId: true, channel: true, region: true, marketplace: true,
      quantity: true, quantityOverride: true, followMasterQuantity: true, stockBuffer: true,
      externalListingId: true, fulfillmentMethod: true, platformAttributes: true,
      product: { select: { sku: true, fulfillmentMethod: true } },
    },
  })
  result.matched = listings.length
  if (listings.length === 0) return result

  const stockRows = await prisma.stockLevel.findMany({
    where: { productId: { in: productIds } },
    select: { productId: true, available: true, quantity: true, location: { select: { type: true } } },
  })
  const warehouseAvailByProduct = new Map<string, number>()
  const fbaQtyByProduct = new Map<string, number>()
  for (const s of stockRows) {
    if (s.location?.type === 'WAREHOUSE') warehouseAvailByProduct.set(s.productId, (warehouseAvailByProduct.get(s.productId) ?? 0) + s.available)
    else if (s.location?.type === 'AMAZON_FBA') fbaQtyByProduct.set(s.productId, (fbaQtyByProduct.get(s.productId) ?? 0) + s.quantity)
  }

  const applicable = listings.filter((cl) => {
    // Invariant B: skip FBA fail-closed (FBA only exists on AMAZON).
    const fba = cl.channel === 'AMAZON' && isFbaListing(
      { fulfillmentMethod: cl.fulfillmentMethod, platformAttributes: cl.platformAttributes },
      { fulfillmentMethod: cl.product?.fulfillmentMethod },
      { fbaStockQty: fbaQtyByProduct.get(cl.productId) ?? 0 },
    )
    if (fba) {
      result.skippedFba++
      result.results.push({ listingId: cl.id, sku: cl.product?.sku ?? null, channel: cl.channel, marketplace: cl.marketplace, action: 'SKIPPED_FBA', buffer: cl.stockBuffer ?? 0, quantity: null })
    }
    return !fba
  })
  if (applicable.length === 0) return result

  // Chunked transactions — same P2028 fix as setFollowMasterQuantity: a bulk
  // buffer over hundreds of listings must never ride one giant interactive tx.
  const queued: Array<{ queueId: string; productId: string }> = []
  let processed = 0
  for (let i = 0; i < applicable.length; i += BULK_TX_CHUNK) {
    const chunk = applicable.slice(i, i + BULK_TX_CHUNK)
    const acc = {
      updated: 0,
      unchanged: 0,
      results: [] as StockBufferResult['results'],
      queued: [] as Array<{ queueId: string; productId: string }>,
    }
    try {
      await prisma.$transaction(async (tx) => {
        acc.updated = 0; acc.unchanged = 0; acc.results.length = 0; acc.queued.length = 0
        const holdUntil = new Date(Date.now() + FOLLOW_HOLD_MS)
        // Per-chunk pool re-read + compute-first — same freshness and no-op
        // preservation rules as the FOLLOW path above.
        const chunkPids = [...new Set(chunk.map((c) => c.productId))]
        const freshStock = await tx.stockLevel.findMany({
          where: { productId: { in: chunkPids }, location: { type: 'WAREHOUSE' } },
          select: { productId: true, available: true },
        })
        const freshAvail = new Map<string, number>()
        for (const st of freshStock) freshAvail.set(st.productId, (freshAvail.get(st.productId) ?? 0) + st.available)
        const plans = chunk.map((cl) => {
          const warehouseAvailable = freshAvail.get(cl.productId) ?? 0
          const write = computeStockBufferWrite(cl, buffer, warehouseAvailable)
          return { cl, write, noOp: isBufferNoOp(cl, write) }
        })
        const willPushIds = plans.filter((p) => !p.noOp && p.write.pushQuantity !== null).map((p) => p.cl.id)
        if (willPushIds.length) await coalescePendingQuantityRows(tx, willPushIds)

        for (const { cl, write, noOp } of plans) {
          if (noOp) {
            acc.unchanged++
            acc.results.push({ listingId: cl.id, sku: cl.product?.sku ?? null, channel: cl.channel, marketplace: cl.marketplace, action: 'UNCHANGED', buffer: write.stockBuffer, quantity: write.quantity })
            continue
          }

          await tx.channelListing.update({
            where: { id: cl.id },
            data: {
              stockBuffer: write.stockBuffer,
              quantity: write.quantity,
              quantityOverride: write.quantityOverride,
              followMasterQuantity: write.followMasterQuantity,
              ...(write.pushQuantity !== null ? { lastSyncStatus: 'PENDING', lastSyncedAt: null } : {}),
              // No version bump — same reasoning as setFollowMasterQuantity.
            },
          })
          acc.updated++
          acc.results.push({ listingId: cl.id, sku: cl.product?.sku ?? null, channel: cl.channel, marketplace: cl.marketplace, action: 'BUFFER', buffer: write.stockBuffer, quantity: write.quantity })

          if (write.pushQuantity !== null && VALID_SYNC_TARGETS.has(cl.channel)) {
            const qRow = await tx.outboundSyncQueue.create({
              data: {
                productId: cl.productId, channelListingId: cl.id, targetChannel: cl.channel as any, targetRegion: cl.region,
                syncStatus: 'PENDING' as any, syncType: 'QUANTITY_UPDATE', holdUntil, externalListingId: cl.externalListingId, maxRetries: 3,
                payload: { source: 'STOCK_BUFFER', productId: cl.productId, channel: cl.channel, marketplace: cl.marketplace, quantity: write.pushQuantity, oldQuantity: cl.quantity, stockBuffer: write.stockBuffer, actor: actor ?? null },
              },
              select: { id: true },
            })
            acc.queued.push({ queueId: qRow.id, productId: cl.productId })
          }
        }
      }, BULK_TX_OPTS)
      result.updated += acc.updated
      result.unchanged += acc.unchanged
      result.results.push(...acc.results)
      queued.push(...acc.queued)
      processed += chunk.length
    } catch (e) {
      if (processed === 0) throw e
      result.error = e instanceof Error ? e.message : String(e)
      result.remaining = applicable.length - processed
      logger.error('stock-buffer: bulk stopped mid-way', {
        channel, buffer, processed, remaining: result.remaining, error: result.error,
      })
      break
    }
  }

  for (const { queueId, productId } of queued) {
    await addJobSafely(outboundSyncQueue, 'sync-job', { queueId, productId, syncType: 'QUANTITY_UPDATE', source: 'STOCK_BUFFER' }, { delay: FOLLOW_HOLD_MS, jobId: queueId })
  }

  logger.info('stock-buffer: applied', { channel, buffer, updated: result.updated, skippedFba: result.skippedFba, matched: result.matched, actor: actor ?? null })
  return result
}
