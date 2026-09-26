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
import { policyFor, loadChannelPolicies } from './sync-control-policy.service.js'
import { resolveMembershipIntended } from './sync-control-core.js'
import { ledgerInputs, loadSyncLedgers } from './stock-pool/sync-ledgers.js'
import { tryResolveConnection } from './connection-resolver.service.js'
import { recordChannelReadback, type DriftField } from './channel-drift.service.js'
import { emptyTradingPriceCounts, runTradingPriceArm, type TradingPriceCounts, type TradingPriceRead } from './ebay-price-readback.service.js'

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

  // PLAN A-54 (R-67) — a PARENT product has no quantity of its own (its variations carry it), so it never has an
  // Inventory-API item. Asking for one logged a false error every sweep (6 on production, 2026-09-24).
  const listings = await prisma.channelListing.findMany({
    where: { channel: 'EBAY', listingStatus: 'ACTIVE', product: { isParent: false } },
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
  // A-54 — the shared skip runs BEFORE the cap, so the cap counts only rows this pass may read (it used to fill with
  // shared rows: 194 of a 200 batch on production, while the rest of the 302 were never looked at).
  const eligible = listings.filter((listing) => !(listing.product?.sku && sharedSkus.has(listing.product.sku)))
  const skippedShared = listings.length - eligible.length

  const capped = eligible.length > cap
  if (capped) {
    logger.warn('ebay-readback: active listings exceed cap; truncating', {
      total: eligible.length,
      cap,
    })
  }
  const batch = capped ? eligible.slice(0, cap) : eligible

  const ebay = new EbayService()
  let checked = 0
  let recorded = 0
  let errors = 0
  const now = new Date()

  for (const listing of batch) {
    const sku = listing.product?.sku
    if (!sku) {
      logger.warn('ebay-readback: listing has no SKU, skipping', {
        listingId: listing.id,
        productId: listing.productId,
      })
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
  /** SC.1b — per-membership overselling buffer, subtracted from intended. */
  stockBuffer?: number
  /** Shared stock step 3 — a fixed number: the variant must show exactly this, whatever the pool. */
  pinnedQuantity?: number | null
}

export interface TradingMismatch {
  sku: string
  itemId: string
  marketplace: string
  productId: string
  ebayQty: number
  intendedQty: number
}

/** Compound observation key — the same pool SKU lives on up to 5 listings and
 *  each listing has its OWN quantity on eBay. Keying observations by bare SKU
 *  let one listing's reading overwrite another's (216 SKUs affected): phantom
 *  mismatches + mis-targeted heals. Owner-observed 2026-07-20. */
export const obsKey = (itemId: string, sku: string): string => `${itemId}\u001f${sku}`

/** Pure diff — exported for tests. Each membership entry is compared against
 *  ITS OWN listing's observation (obsKey). `intendedByProduct` only contains
 *  COUNTED products (uncounted = empty warehouse ledger must never be
 *  "healed" to 0, mirroring the cascade's P0 guard). */
export function diffTradingReadback(
  entries: TradingReadbackEntry[],
  observedByItemSku: Map<string, number>,
  intendedByProduct: Map<string, number>,
  opts: { now?: number; settleMs?: number } = {},
): TradingMismatch[] {
  const out: TradingMismatch[] = []
  for (const e of entries) {
    const v = tradingEntryVerdict(e, observedByItemSku, intendedByProduct, opts)
    if (v && v.observed !== v.intended) {
      out.push({
        sku: e.sku,
        itemId: e.itemId,
        marketplace: e.marketplace,
        productId: e.productId as string,
        ebayQty: v.observed,
        intendedQty: v.intended,
      })
    }
  }
  return out
}

/** The ONE comparison rule for a membership entry — `diffTradingReadback` and the drift records (A-36) both read it,
 *  so "compared" cannot mean two things. `null` = not compared this run: no product, no observation, intent unknown
 *  (uncounted / paused), or pushed inside the settle window. */
export function tradingEntryVerdict(
  e: TradingReadbackEntry,
  observedByItemSku: Map<string, number>,
  intendedByProduct: Map<string, number>,
  opts: { now?: number; settleMs?: number } = {},
): { observed: number; intended: number } | null {
  const now = opts.now ?? Date.now()
  const settleMs = opts.settleMs ?? 90_000
  if (!e.productId) return null
  const observed = observedByItemSku.get(obsKey(e.itemId, e.sku))
  if (observed === undefined) return null
  let intended: number
  if (e.pinnedQuantity != null) {
    intended = e.pinnedQuantity
  } else {
    const intendedBase = intendedByProduct.get(e.productId)
    if (intendedBase === undefined) return null
    intended = Math.max(0, intendedBase - Math.max(0, e.stockBuffer ?? 0))
  }
  if (e.lastPushedAt && now - e.lastPushedAt.getTime() < settleMs) return null
  return { observed, intended }
}

/** An eBay listing row as the drift mapping needs it. */
export interface TradingListingRow {
  id: string
  productId: string
  marketplace: string
  externalListingId: string | null
  product: { parentId: string | null } | null
}

export interface TradingDriftRecord {
  channelListingId: string
  marketplace: string
  compared: string[]
  differing: DriftField[]
}

/**
 * PLAN Step 3.5 (A-36, R-36) — the eBay slice: where one (ItemID, SKU) reading lands, per LISTING.
 *
 * A membership is not a listing. It lands on (1) the eBay listing of THAT product on THAT ItemID when Nexus holds one
 * (field `quantity`), else (2) the ItemID's own listing — its ONE parentless owner row, a shell or the family parent —
 * with the SKU in the field (`quantity:<SKU>`: one listing holds many variants). No owner, or two, is ambiguous: the
 * entry is counted as unmapped, never guessed. Measured on the local copy: every ItemID has exactly one owner (30/30).
 * A SKU on two ItemIDs lands on both listings; each ItemID is its own listing.
 */
export function tradingDriftRecords(
  entries: TradingReadbackEntry[],
  observedByItemSku: Map<string, number>,
  intendedByProduct: Map<string, number>,
  rows: TradingListingRow[],
  opts: { now?: number; settleMs?: number } = {},
): { records: TradingDriftRecord[]; unmapped: number } {
  const byListing = new Map<string, TradingDriftRecord>()
  let unmapped = 0
  for (const e of entries) {
    const v = tradingEntryVerdict(e, observedByItemSku, intendedByProduct, opts)
    if (!v) continue
    const onItem = rows.filter((r) => r.externalListingId === e.itemId && r.marketplace === e.marketplace)
    const exact = onItem.filter((r) => r.productId === e.productId)
    const owners = onItem.filter((r) => !r.product?.parentId)
    const target = exact.length === 1 ? { row: exact[0], field: 'quantity' }
      : exact.length === 0 && owners.length === 1 ? { row: owners[0], field: `quantity:${e.sku}` }
      : null
    if (!target) { unmapped++; continue }
    const rec = byListing.get(target.row.id) ?? { channelListingId: target.row.id, marketplace: target.row.marketplace, compared: [], differing: [] }
    if (!rec.compared.includes(target.field)) rec.compared.push(target.field)
    if (v.observed !== v.intended) rec.differing.push({ field: target.field, ours: v.intended, theirs: v.observed })
    byListing.set(target.row.id, rec)
  }
  return { records: [...byListing.values()], unmapped }
}

export interface TradingReadBackResult {
  items: number
  skusChecked: number
  mismatches: number
  logged: number
  healedProducts: number
  /** SC.5-fix — UNRESOLVED readback logs cleared because the product read back fully in-sync. */
  resolved: number
  endedMemberships: number
  errors: number
  capped: boolean
  /** A-36 — listings recorded in ChannelDrift this run (clean ones included, at 0). */
  driftRecorded: number
  /** A-36 — compared entries whose ItemID names no single listing here: counted, never guessed. */
  driftUnmapped: number
  /** P4.4 (CX) — the price arm, beside the quantity arm and never folded into it. Report-only. */
  price: TradingPriceCounts
}

/**
 * SC.5-fix — stagger heal enqueues so corrective rows touching the SAME eBay
 * item never fire inside the 15s revise debounce window of one another.
 * Returns per-product holdUntil offsets (ms). Pure for testability.
 */
export function computeHealHoldOffsets(
  productIds: string[],
  itemIdsByProduct: Map<string, string[]>,
  spacingMs: number,
): Map<string, number> {
  const nextSlotPerItem = new Map<string, number>()
  const out = new Map<string, number>()
  for (const pid of productIds) {
    const items = itemIdsByProduct.get(pid) ?? []
    let offset = 0
    for (const it of items) offset = Math.max(offset, nextSlotPerItem.get(it) ?? 0)
    out.set(pid, offset)
    for (const it of items) nextSlotPerItem.set(it, offset + spacingMs)
  }
  return out
}

const EBAY_HEAL_STAGGER_MS = 16_000 // just over the 15s revise debounce

export async function readBackEbayTradingQuantities(): Promise<TradingReadBackResult> {
  const result: TradingReadBackResult = {
    items: 0,
    skusChecked: 0,
    mismatches: 0,
    logged: 0,
    healedProducts: 0,
    resolved: 0,
    endedMemberships: 0,
    errors: 0,
    capped: false,
    driftRecorded: 0,
    driftUnmapped: 0,
    price: emptyTradingPriceCounts(),
  }

  const allMemberships = await prisma.sharedListingMembership.findMany({
    where: { status: 'ACTIVE' },
    select: { itemId: true, marketplace: true, sku: true, productId: true, lastPushedAt: true, stockBuffer: true, pinnedQuantity: true, price: true, channelConnectionId: true, followPool: true },
  })
  if (allMemberships.length === 0) return result
  // SC.1 — followPool=false members are operator-excluded from the QUANTITY arm: never compared,
  // never healed (their eBay quantity is deliberately theirs to manage). CX (review 2026-09-26) — the
  // price arm still compares them: followPool governs the pool fan-out (sync-control-core maps it to
  // a listing pause for quantity), and nothing about it touches the price.
  const memberships = allMemberships.filter((m) => m.followPool !== false)

  // MAP.3 — DECLARED. 🔴 MAP.7: memberships carry channelConnectionId now, so
  // this should group them by account and read back with each account's token.
  const connection = await tryResolveConnection({ channel: 'EBAY', primary: true })
  if (!connection) return result
  const token = await ebayAuthService.getValidToken(connection.id)

  const envMax = Number.parseInt(process.env.NEXUS_EBAY_TRADING_READBACK_MAX ?? '', 10)
  const maxItems = Number.isFinite(envMax) && envMax > 0 ? envMax : DEFAULT_MAX_TRADING_ITEMS

  // Group memberships per (itemId, marketplace) — one GetItem per listing. `entries` are the quantity
  // arm's (followed only); a listing whose every variant is excluded is read for its prices alone.
  const byItem = new Map<string, { itemId: string; marketplace: string; entries: TradingReadbackEntry[] }>()
  for (const m of allMemberships) {
    const key = `${m.marketplace}:${m.itemId}`
    const g = byItem.get(key) ?? { itemId: m.itemId, marketplace: m.marketplace, entries: [] }
    byItem.set(key, g)
    if (m.followPool === false) continue
    g.entries.push({
      sku: m.sku,
      itemId: m.itemId,
      marketplace: m.marketplace,
      productId: m.productId,
      lastPushedAt: m.lastPushedAt,
      stockBuffer: (m as { stockBuffer?: number }).stockBuffer ?? 0,
      pinnedQuantity: m.pinnedQuantity,
    })
    byItem.set(key, g)
  }
  // Followed listings first: the read cap never trades quantity coverage for a price-only read.
  const groups = [...byItem.values()].sort((a, b) => Number(b.entries.length > 0) - Number(a.entries.length > 0))
  result.capped = groups.length > maxItems
  const batch = groups.slice(0, maxItems)
  result.items = batch.length

  // SC.1 — pool truth per (product × marketplace) via the derivation core
  // (routing + channel policy; per-membership buffers land in SC.1b). Routed-
  // UNCOUNTED / policy-PAUSED products stay OUT of the intended map entirely
  // (never compared, never healed) — the pre-SC uncounted exclusion, now
  // routing-aware.
  const productIds = [...new Set(memberships.map((m) => m.productId).filter((p): p is string => Boolean(p)))]
  // Shared stock — the ledger comes from loadSyncLedgers: a pooled product is compared with, and
  // healed to, the pool; its own (often empty) stock would otherwise "heal" a correct number to 0.
  const ledgers = await loadSyncLedgers(prisma, productIds)
  const scPolicies = await loadChannelPolicies()
  const marketplaceByProduct = new Map<string, string>()
  for (const m of memberships) if (m.productId && !marketplaceByProduct.has(m.productId)) marketplaceByProduct.set(m.productId, m.marketplace)
  const intendedByProduct = new Map<string, number>()
  for (const [pid, product] of ledgers) {
    const r = resolveMembershipIntended({
      marketplace: marketplaceByProduct.get(pid) ?? 'EBAY_IT',
      followPool: true,
      stockBuffer: 0,
      channelPolicy: policyFor(scPolicies, 'EBAY', marketplaceByProduct.get(pid) ?? 'EBAY_IT'),
      ledger: product.ledger,
      uncountedIsZero: product.uncountedIsZero,
    })
    if (r.kind === 'FOLLOW') intendedByProduct.set(pid, r.quantity)
  }

  const observedByItemSku = new Map<string, number>()
  const checkedEntries: TradingReadbackEntry[] = []
  const priceReads: TradingPriceRead[] = [] // P4.4 (CX) — the same answers, for the price arm

  for (const g of batch) {
    try {
      const rb = await getItemQuantities(g.itemId, { oauthToken: token, market: g.marketplace, connectionId: connection.id })

      if (rb.listingStatus && ENDED_STATUSES.has(rb.listingStatus)) {
        // A price-only read (every variant excluded) writes nothing: ending memberships stays the quantity sweep's call.
        if (g.entries.length === 0) continue
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
        for (const v of rb.variations) observedByItemSku.set(obsKey(g.itemId, v.sku), v.available)
      } else if (rb.itemAvailable !== null && g.entries.length === 1) {
        // Single-SKU Trading listing — the item-level pair is that SKU's truth.
        observedByItemSku.set(obsKey(g.itemId, g.entries[0].sku), rb.itemAvailable)
      }
      checkedEntries.push(...g.entries)
      priceReads.push({ itemId: g.itemId, marketplace: g.marketplace, prices: rb.prices })
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

  result.skusChecked = checkedEntries.filter((e) => observedByItemSku.has(obsKey(e.itemId, e.sku))).length
  // One clock for the diff and the drift records, so both see the same settle window.
  const comparedAt = Date.now()
  const diffs = diffTradingReadback(checkedEntries, observedByItemSku, intendedByProduct, { now: comparedAt })
  result.mismatches = diffs.length

  // A-36 (Step 3.5, the eBay slice) — per LISTING, through the one writer. Best effort, and never this run's verdict:
  // a failed drift write must not change a mismatch, a log or a heal below.
  try {
    const itemIds = [...new Set(checkedEntries.map((e) => e.itemId))]
    const rows = itemIds.length === 0 ? [] : await prisma.channelListing.findMany({
      where: { channel: 'EBAY', externalListingId: { in: itemIds }, product: { deletedAt: null } },
      select: { id: true, productId: true, marketplace: true, externalListingId: true, product: { select: { parentId: true } } },
    })
    const drift = tradingDriftRecords(checkedEntries, observedByItemSku, intendedByProduct, rows, { now: comparedAt })
    result.driftUnmapped = drift.unmapped
    for (const rec of drift.records) {
      try {
        await recordChannelReadback({ channelListingId: rec.channelListingId, channel: 'EBAY', marketplace: rec.marketplace,
          source: 'ebay-trading-getitem', compared: rec.compared, differing: rec.differing, checkedAt: new Date(comparedAt) })
        result.driftRecorded++
      } catch { /* observability best-effort */ }
    }
  } catch (err) {
    logger.warn('ebay-trading-readback: drift records skipped', { error: err instanceof Error ? err.message : String(err) })
  }

  // Heal penetration (owner-approved 2026-07-20): the corrective fan-out's
  // no-op drop keys on membership.lastQtyPushed — when that stamp is wrong
  // (partial batch, eBay silently keeping an old number), every heal for the
  // SKU builds ZERO revises, forever (measured: mismatch=85 frozen across 8
  // runs while "healed=25" each time). Correct the stamp to eBay's OWN
  // answer first; the fan-out then sees a real delta and pushes pool truth.
  for (const d of diffs) {
    try {
      await prisma.sharedListingMembership.updateMany({
        where: { marketplace: d.marketplace, itemId: d.itemId, sku: d.sku },
        data: {
          lastQtyPushed: d.ebayQty,
          lastError: `readback: eBay showed ${d.ebayQty} vs pool ${d.intendedQty} — stamp corrected so the heal penetrates`,
        },
      })
    } catch (err) {
      logger.warn('ebay-trading-readback: stamp correction failed', {
        itemId: d.itemId,
        sku: d.sku,
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }

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

  // Self-heal: ONE corrective fan-out per mismatched product re-syncs every
  // listing of that product; dispatch re-reads the pool and drops no-ops.
  // SC.5-fix — the old default cap (25) with deterministic ordering starved
  // every product past the cut PERMANENTLY (measured: 60 mismatched, 35 never
  // healed across days — VENTRA-4XL live oversell). Heal them ALL (safety cap
  // 200), and stagger same-item rows past the revise debounce so convergence
  // is one cycle, not one-SKU-per-episode.
  const healEnvMax = Number.parseInt(process.env.NEXUS_EBAY_READBACK_HEAL_MAX ?? '', 10)
  const healMax = Number.isFinite(healEnvMax) && healEnvMax >= 0 ? healEnvMax : 200
  const mismatchedProducts = [...new Set(diffs.map((d) => d.productId))]
  if (mismatchedProducts.length > healMax) {
    logger.warn('ebay-trading-readback: heal cap hit — tail deferred to next run', {
      mismatched: mismatchedProducts.length,
      healMax,
    })
  }
  const itemIdsByProduct = new Map<string, string[]>()
  for (const m of memberships) {
    if (!m.productId) continue
    const arr = itemIdsByProduct.get(m.productId) ?? []
    arr.push(m.itemId)
    itemIdsByProduct.set(m.productId, arr)
  }
  const healTargets = mismatchedProducts.slice(0, healMax)
  const holdOffsets = computeHealHoldOffsets(healTargets, itemIdsByProduct, EBAY_HEAL_STAGGER_MS)
  for (const pid of healTargets) {
    try {
      // The same per-membership derivation as the cascade (routing, Excluded, buffer), from the same
      // ledger, so the heal can never push a number the cascade would not.
      const product = ledgers.get(pid)
      await enqueueSharedTradingFanout(prisma, {
        productId: pid,
        holdUntil: new Date(Date.now() + (holdOffsets.get(pid) ?? 0)),
        scLedger: ledgerInputs(product).ledger,
        uncountedIsZero: ledgerInputs(product).uncountedIsZero,
        scPolicies,
      })
      result.healedProducts++
    } catch (err) {
      logger.warn('ebay-trading-readback: heal enqueue failed', {
        productId: pid,
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }

  // SC.5-fix — convergence auto-resolve: a product whose EVERY followed
  // listing was read back this run with zero diffs is in sync — clear its
  // UNRESOLVED readback logs so /api/health counts OPEN drift, not history.
  try {
    const batchKeys = new Set(batch.map((g) => `${g.marketplace}:${g.itemId}`))
    const itemsByProductAll = new Map<string, string[]>()
    for (const m of memberships) {
      if (!m.productId) continue
      const arr = itemsByProductAll.get(m.productId) ?? []
      arr.push(`${m.marketplace}:${m.itemId}`)
      itemsByProductAll.set(m.productId, arr)
    }
    const mismatchedSet = new Set(diffs.map((d) => d.productId))
    const checkedProductIds = new Set(
      checkedEntries
        .filter((e) => observedByItemSku.has(obsKey(e.itemId, e.sku)))
        .map((e) => e.productId)
        .filter((v): v is string => Boolean(v)),
    )
    const converged = [...checkedProductIds].filter((pid) => {
      if (mismatchedSet.has(pid)) return false
      const keys = itemsByProductAll.get(pid) ?? []
      return keys.every((k) => batchKeys.has(k)) // partial coverage never resolves
    })
    if (converged.length > 0) {
      const res = await prisma.syncHealthLog.updateMany({
        where: {
          productId: { in: converged },
          channel: 'EBAY',
          conflictType: 'CHANNEL_QTY_READBACK',
          resolutionStatus: 'UNRESOLVED',
        },
        data: {
          resolutionStatus: 'RESOLVED',
          resolvedAt: new Date(),
          resolutionNotes: 'auto-resolved: trading read-back matched pool intent on every listing',
        },
      })
      result.resolved = res.count
    }
  } catch (err) {
    logger.warn('ebay-trading-readback: convergence auto-resolve failed', {
      error: err instanceof Error ? err.message : String(err),
    })
  }

  // P4.4 (CX) — the PRICE arm over the GetItem answers above (no extra call), for the token's own
  // account's memberships only. 🔴 Report-only: it never heals (no fan-out, no queue row).
  result.price = await runTradingPriceArm({ memberships: allMemberships, reads: priceReads, accountId: connection.id, keyOf: obsKey })

  logger.info('ebay-trading-readback: sweep complete', { ...result })
  return result
}
