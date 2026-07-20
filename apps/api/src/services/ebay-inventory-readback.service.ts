/**
 * P5.2 — eBay inventory read-back → ChannelStockEvent
 *
 * Polls eBay's Inventory API for each active eBay listing and feeds
 * the observed quantity into the existing recordChannelStockEvent
 * pipeline (CS.1).  That pipeline handles drift classification,
 * ≤1u auto-apply, and REVIEW_NEEDED routing — this service adds
 * NO new healing logic of its own.
 *
 * Design constraints:
 *   - Read-only: we never write to eBay here.
 *   - Bounded: at most NEXUS_EBAY_READBACK_MAX listings per run (default 200).
 *   - Per-SKU try/catch: one 404/timeout does not abort the sweep.
 *   - Idempotent: channelEventId is hour-bucketed; re-runs in the same
 *     clock-hour dedup via the (channel, channelEventId) unique index.
 */

import prisma from '../db.js'
import { EbayService } from './marketplaces/ebay.service.js'
import { recordChannelStockEvent } from './channel-stock-event.service.js'
import { logger } from '../utils/logger.js'
import { ebayAuthService } from './ebay-auth.service.js'
import { getItemQuantities } from './ebay-trading-api.service.js'
import { computeAvailableToPublish } from './available-to-publish.service.js'
import { enqueueSharedTradingFanout } from './ebay-shared-fanout.service.js'

const DEFAULT_MAX_SKUS = 200
const DEFAULT_MAX_TRADING_ITEMS = 50
const TRADING_CALL_SPACING_MS = 300
const ENDED_STATUSES = new Set(['Completed', 'Ended'])

// ---------------------------------------------------------------------------
// Pure helpers — exported so they can be unit-tested without DB/network
// ---------------------------------------------------------------------------

/**
 * Build the idempotency key for a readback observation.
 * Format: `ebay-readback:<sku>:<YYYY-MM-DDTHH>` (ISO-8601 hour bucket).
 * Two calls in the same clock-hour produce the same key → the second
 * insert is a no-op via the unique index.
 */
export function ebayReadbackEventId(sku: string, d: Date): string {
  return `ebay-readback:${sku}:${d.toISOString().slice(0, 13)}`
}

/**
 * Extract the current published quantity from a raw eBay inventory item
 * response object.  Returns the quantity as a non-negative integer, or
 * null if the field is absent, non-numeric, or negative.
 */
export function extractEbayPublishedQty(item: unknown): number | null {
  const raw =
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (item as any)?.availability?.shipToLocationAvailability?.quantity
  if (raw === undefined || raw === null) return null
  const n = Number(raw)
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < 0) return null
  return n
}

// ---------------------------------------------------------------------------
// Orchestrator
// ---------------------------------------------------------------------------

export interface ReadBackResult {
  checked: number
  recorded: number
  errors: number
  capped: boolean
}

/**
 * Sweep all active eBay listings, GET each SKU from eBay, and feed the
 * observed quantity into recordChannelStockEvent.
 */
export async function readBackEbayInventory(
  opts: { maxSkus?: number } = {},
): Promise<ReadBackResult> {
  const envMax = process.env.NEXUS_EBAY_READBACK_MAX
    ? Number.parseInt(process.env.NEXUS_EBAY_READBACK_MAX, 10)
    : DEFAULT_MAX_SKUS
  // Harden against a typo'd env var (NaN) silently UNCAPPING the sweep → a
  // potential flood of eBay read calls. Fall back to the default.
  const cap = opts.maxSkus ?? (Number.isFinite(envMax) && envMax > 0 ? envMax : DEFAULT_MAX_SKUS)

  const listings = await prisma.channelListing.findMany({
    where: { channel: 'EBAY', listingStatus: 'ACTIVE' },
    select: {
      id: true,
      productId: true,
      product: { select: { sku: true } },
    },
  })

  // AS.4a — Trading-lane (shared-membership) SKUs have NO Inventory-API item;
  // GETting them 404s by construction. Before this skip, the current all-
  // Trading topology made every sweep read `checked=129 errors=129` — pure
  // noise that buried real errors. Their read-back is readBackEbayTradingQuantities.
  const sharedSkuRows = await prisma.sharedListingMembership.findMany({
    where: { status: 'ACTIVE' },
    select: { sku: true },
  })
  const sharedSkus = new Set(sharedSkuRows.map((m) => m.sku))

  const capped = listings.length > cap
  if (capped) {
    logger.warn('ebay-readback: active listings exceed cap; truncating', {
      total: listings.length,
      cap,
    })
  }
  const batch = capped ? listings.slice(0, cap) : listings

  const ebay = new EbayService()
  let checked = 0
  let recorded = 0
  let errors = 0
  const now = new Date()

  let skippedShared = 0

  for (const listing of batch) {
    const sku = listing.product?.sku
    if (!sku) {
      logger.warn('ebay-readback: listing has no SKU, skipping', {
        listingId: listing.id,
        productId: listing.productId,
      })
      continue
    }
    if (sharedSkus.has(sku)) {
      skippedShared++
      continue
    }

    checked++

    try {
      const item = await ebay.getPublishedInventoryItem(sku)
      if (item === null) {
        // 404 — item not on eBay; skip silently
        logger.debug('ebay-readback: SKU not found on eBay, skipping', { sku })
        continue
      }

      const qty = extractEbayPublishedQty(item)
      if (qty === null) {
        logger.warn('ebay-readback: could not extract valid qty, skipping', {
          sku,
          availability: (item as Record<string, unknown>).availability,
        })
        continue
      }

      await recordChannelStockEvent({
        channel: 'EBAY',
        sku,
        channelReportedQty: qty,
        channelEventId: ebayReadbackEventId(sku, now),
        rawPayload: item,
      })

      recorded++
    } catch (err) {
      errors++
      logger.error('ebay-readback: per-SKU error', {
        sku,
        err: err instanceof Error ? err.message : String(err),
      })
    }
  }

  logger.info('ebay-readback: sweep complete', {
    checked,
    recorded,
    errors,
    skippedShared,
    capped,
  })

  return { checked, recorded, errors, capped }
}

// ---------------------------------------------------------------------------
// AS.4a — Trading-lane quantity read-back (shared listings)
// ---------------------------------------------------------------------------
//
// One pool SKU lives on up to 5 eBay listings via SharedListingMembership;
// those listings speak Trading, not the Inventory API. This pass asks eBay
// (GetItem, IncludeVariations) what each listing ACTUALLY advertises and
// compares it against pool truth (warehouse available, shared lane has no
// buffer — same math as the cascade/fan-out).
//
// Semantics — deliberately the Amazon P0c model, NOT recordChannelStockEvent:
// the CS.1 pipeline auto-applies small drift INTO the pool, which is correct
// for single-listing channels but poison for shared listings (in the window
// between a sale and its fan-out revise, every OTHER listing of that SKU
// still shows the pre-sale number; adopting it would corrupt the pool).
// Here the pool is the authority: divergence → SyncHealthLog
// CHANNEL_QTY_READBACK (deduped) + a bounded corrective fan-out re-push.
// Transient windows are absorbed twice: entries pushed within `settleMs` are
// skipped, and a heal that re-pushes an already-correct value costs zero
// revises (dispatch-time re-read drops no-ops).

export interface TradingReadbackEntry {
  sku: string
  itemId: string
  marketplace: string
  productId: string | null
  lastPushedAt: Date | null
}

export interface TradingMismatch {
  sku: string
  itemId: string
  marketplace: string
  productId: string
  ebayQty: number
  intendedQty: number
}

/** Pure diff — exported for tests. `intendedByProduct` only contains COUNTED
 *  products (uncounted = empty warehouse ledger must never be "healed" to 0,
 *  mirroring the cascade's P0 guard). */
export function diffTradingReadback(
  entries: TradingReadbackEntry[],
  observedBySku: Map<string, number>,
  intendedByProduct: Map<string, number>,
  opts: { now?: number; settleMs?: number } = {},
): TradingMismatch[] {
  const now = opts.now ?? Date.now()
  const settleMs = opts.settleMs ?? 90_000
  const out: TradingMismatch[] = []
  for (const e of entries) {
    if (!e.productId) continue
    const observed = observedBySku.get(e.sku)
    if (observed === undefined) continue
    const intended = intendedByProduct.get(e.productId)
    if (intended === undefined) continue
    if (e.lastPushedAt && now - e.lastPushedAt.getTime() < settleMs) continue
    if (observed !== intended) {
      out.push({
        sku: e.sku,
        itemId: e.itemId,
        marketplace: e.marketplace,
        productId: e.productId,
        ebayQty: observed,
        intendedQty: intended,
      })
    }
  }
  return out
}

export interface TradingReadBackResult {
  items: number
  skusChecked: number
  mismatches: number
  logged: number
  healedProducts: number
  endedMemberships: number
  errors: number
  capped: boolean
}

export async function readBackEbayTradingQuantities(): Promise<TradingReadBackResult> {
  const result: TradingReadBackResult = {
    items: 0,
    skusChecked: 0,
    mismatches: 0,
    logged: 0,
    healedProducts: 0,
    endedMemberships: 0,
    errors: 0,
    capped: false,
  }

  const memberships = await prisma.sharedListingMembership.findMany({
    where: { status: 'ACTIVE' },
    select: { itemId: true, marketplace: true, sku: true, productId: true, lastPushedAt: true },
  })
  if (memberships.length === 0) return result

  const connection = await prisma.channelConnection.findFirst({
    where: { channelType: 'EBAY', isActive: true },
    select: { id: true },
  })
  if (!connection) return result
  const token = await ebayAuthService.getValidToken(connection.id)

  const envMax = Number.parseInt(process.env.NEXUS_EBAY_TRADING_READBACK_MAX ?? '', 10)
  const maxItems = Number.isFinite(envMax) && envMax > 0 ? envMax : DEFAULT_MAX_TRADING_ITEMS

  // Group memberships per (itemId, marketplace) — one GetItem per listing.
  const byItem = new Map<string, { itemId: string; marketplace: string; entries: TradingReadbackEntry[] }>()
  for (const m of memberships) {
    const key = `${m.marketplace}:${m.itemId}`
    const g = byItem.get(key) ?? { itemId: m.itemId, marketplace: m.marketplace, entries: [] }
    g.entries.push({
      sku: m.sku,
      itemId: m.itemId,
      marketplace: m.marketplace,
      productId: m.productId,
      lastPushedAt: m.lastPushedAt,
    })
    byItem.set(key, g)
  }
  const groups = [...byItem.values()]
  result.capped = groups.length > maxItems
  const batch = groups.slice(0, maxItems)
  result.items = batch.length

  // Pool truth per product — exact cascade math (WAREHOUSE available, no
  // shared-lane buffer). Products with ZERO warehouse rows are UNCOUNTED and
  // excluded from the intended map entirely (never compared, never healed).
  const productIds = [...new Set(memberships.map((m) => m.productId).filter((p): p is string => Boolean(p)))]
  const levels = await prisma.stockLevel.findMany({
    where: { productId: { in: productIds } },
    select: { productId: true, available: true, location: { select: { type: true } } },
  })
  const warehouseSum = new Map<string, number>()
  for (const l of levels) {
    if (l.location?.type !== 'WAREHOUSE') continue
    warehouseSum.set(l.productId, (warehouseSum.get(l.productId) ?? 0) + l.available)
  }
  const intendedByProduct = new Map<string, number>()
  for (const [pid, warehouseAvailable] of warehouseSum) {
    intendedByProduct.set(
      pid,
      computeAvailableToPublish({
        fulfillmentMethod: 'FBM',
        warehouseAvailable,
        fbaSellable: 0,
        stockBuffer: 0,
      }).available,
    )
  }

  const observedBySku = new Map<string, number>()
  const checkedEntries: TradingReadbackEntry[] = []

  for (const g of batch) {
    try {
      const rb = await getItemQuantities(g.itemId, { oauthToken: token, market: g.marketplace })

      if (rb.listingStatus && ENDED_STATUSES.has(rb.listingStatus)) {
        const res = await prisma.sharedListingMembership.updateMany({
          where: { marketplace: g.marketplace, itemId: g.itemId, status: 'ACTIVE' },
          data: {
            status: 'ENDED',
            lastError: `trading-readback: eBay ListingStatus=${rb.listingStatus} (${new Date().toISOString().slice(0, 10)})`,
          },
        })
        result.endedMemberships += res.count
        logger.warn('ebay-trading-readback: item ended on eBay — memberships marked ENDED', {
          itemId: g.itemId,
          marketplace: g.marketplace,
          listingStatus: rb.listingStatus,
          memberships: res.count,
        })
        continue
      }

      if (rb.variations.length > 0) {
        for (const v of rb.variations) observedBySku.set(v.sku, v.available)
      } else if (rb.itemAvailable !== null && g.entries.length === 1) {
        // Single-SKU Trading listing — the item-level pair is that SKU's truth.
        observedBySku.set(g.entries[0].sku, rb.itemAvailable)
      }
      checkedEntries.push(...g.entries)
    } catch (err) {
      result.errors++
      logger.warn('ebay-trading-readback: GetItem failed — skipped (fail-open per item)', {
        itemId: g.itemId,
        marketplace: g.marketplace,
        error: err instanceof Error ? err.message : String(err),
      })
    }
    await new Promise((r) => setTimeout(r, TRADING_CALL_SPACING_MS))
  }

  result.skusChecked = checkedEntries.filter((e) => observedBySku.has(e.sku)).length
  const diffs = diffTradingReadback(checkedEntries, observedBySku, intendedByProduct)
  result.mismatches = diffs.length

  // Persist mismatches (deduped 24h per product, mirroring amazon-qty-readback).
  for (const d of diffs) {
    try {
      const existing = await prisma.syncHealthLog.findFirst({
        where: {
          productId: d.productId,
          channel: 'EBAY',
          conflictType: 'CHANNEL_QTY_READBACK',
          resolutionStatus: 'UNRESOLVED',
          createdAt: { gte: new Date(Date.now() - 24 * 3600e3) },
        },
        select: { id: true },
      })
      if (!existing) {
        const { syncHealthService } = await import('./sync-health.service.js')
        await syncHealthService.logConflict({
          channel: 'EBAY',
          conflictType: 'CHANNEL_QTY_READBACK',
          message: `eBay shows qty ${d.ebayQty} but pool intends ${d.intendedQty} for ${d.sku} (item ${d.itemId}, ${d.marketplace})`,
          productId: d.productId,
          localData: { intendedQty: d.intendedQty },
          remoteData: { source: 'TRADING_GETITEM', ebayQty: d.ebayQty, itemId: d.itemId, marketplace: d.marketplace },
        })
        result.logged++
      }
    } catch {
      /* observability best-effort */
    }
  }

  // Bounded self-heal: ONE corrective fan-out per mismatched product re-syncs
  // every listing of that product; dispatch re-reads the pool and drops
  // no-ops, so a transient mismatch heals for free.
  const healEnvMax = Number.parseInt(process.env.NEXUS_EBAY_READBACK_HEAL_MAX ?? '', 10)
  const healMax = Number.isFinite(healEnvMax) && healEnvMax >= 0 ? healEnvMax : 25
  const mismatchedProducts = [...new Set(diffs.map((d) => d.productId))]
  for (const pid of mismatchedProducts.slice(0, healMax)) {
    try {
      await enqueueSharedTradingFanout(prisma, {
        productId: pid,
        warehouseAvailable: warehouseSum.get(pid) ?? 0,
        stockBuffer: 0,
        holdUntil: new Date(), // heal rows are dispatch-eligible immediately
      })
      result.healedProducts++
    } catch (err) {
      logger.warn('ebay-trading-readback: heal enqueue failed', {
        productId: pid,
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }

  logger.info('ebay-trading-readback: sweep complete', { ...result })
  return result
}
