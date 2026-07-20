/**
 * Stock Import Service — IM.1
 *
 * Resolution engine + import pipeline for the bulk inventory wizard.
 *
 * Resolution tiers (in order):
 *   1. Exact Product.sku match
 *   2. SkuAlias.alias match (operator-defined or import-confirmed)
 *   3. Channel identity match — eBay custom labels (SharedListingMembership.sku),
 *      Amazon FNSKU (Product.fnsku), ASIN (ChannelListing ids) — so files
 *      exported FROM a marketplace resolve without manual mapping (IM.2 P2)
 *   4. Barcode match (product.ean / product.upc) — before fuzzy: an exact
 *      barcode hit must never lose to a name guess
 *   5. Fuzzy product.name match, gated: auto-accepts only a clear winner;
 *      ambiguous scores return UNRESOLVED with ranked candidates
 *   Unresolved → status 'UNRESOLVED', must be manually assigned before commit
 *
 * Modes:
 *   ADJUST — add / subtract delta (signed integer)
 *   SET    — set absolute quantity
 *
 * Targets:
 *   WAREHOUSE — update StockLevel (calls applyStockMovement)
 *   CHANNEL   — update ChannelListing.quantityOverride for FBM listings
 *   BOTH      — warehouse + channel
 */

import { randomUUID } from 'node:crypto'
import type { Prisma } from '@prisma/client'
import prisma from '../db.js'
import { resolveListingFulfillmentMethod, resolveCascadePushMethod } from './stock-movement.service.js'
import { coalescePendingQuantityRows } from './sync-coalesce.js'
import { computeAvailableToPublish } from './available-to-publish.service.js'
import { buildSharedFanoutRows, type SharedMembershipRow } from './ebay-shared-fanout.service.js'
import { handleMovementStockoutTransition } from './stockout-detector.service.js'
import { productReadCacheService } from './product-read-cache.service.js'
import { outboundSyncQueue, addJobSafely } from '../lib/queue.js'
import { logger } from '../utils/logger.js'

// Same undo-grace as manual stock edits (see stock-movement.service.ts) —
// gives the operator a window to re-import before the push dispatches.
const IMPORT_HOLD_MS = 30 * 1000

// ── Public types ─────────────────────────────────────────────────────────────

export type ResolutionTier = 'EXACT' | 'ALIAS' | 'CHANNEL_SKU' | 'FUZZY_NAME' | 'BARCODE' | 'UNRESOLVED'
export type ImportMode = 'ADJUST' | 'SET'
export type ImportTarget = 'WAREHOUSE' | 'CHANNEL' | 'BOTH'

export interface ImportRow {
  /** Identifier as it appeared in the file (may not be a valid SKU) */
  raw: string
  /** Resolved canonical SKU (filled after resolution) */
  sku?: string
  /** Numeric quantity: signed delta for ADJUST, absolute for SET */
  quantity: number
  /** Optional channel name for CHANNEL target (e.g. 'AMAZON', 'EBAY') */
  channel?: string
  /** Optional marketplace for CHANNEL target (e.g. 'IT', 'DE') */
  marketplace?: string
  notes?: string
}

export interface ResolvedRow extends ImportRow {
  productId: string | null
  productName: string | null
  resolvedSku: string | null
  tier: ResolutionTier
  candidates: Array<{ productId: string; sku: string; name: string; score: number }>
}

export interface ChannelListingPreview {
  id: string
  channel: string
  marketplace: string
  current: number
  wouldBe: number
  clamped: boolean
}

export interface PreviewRow extends ResolvedRow {
  currentWarehouseQty: number | null
  wouldBeWarehouseQty: number | null
  currentChannelQty: number | null
  wouldBeChannelQty: number | null
  /** IM.2 P3 — per-listing detail for CHANNEL/BOTH targets (preview = apply). */
  channelListings: ChannelListingPreview[]
  warnings: string[]
  error: string | null
}

export interface PreviewResult {
  rows: PreviewRow[]
  resolved: number
  fuzzy: number
  unresolved: number
  errors: number
  wouldUpdate: number
}

export interface ApplyResult {
  jobId: string
  succeeded: number
  failed: number
  skipped: number
  total: number
  results: Array<{
    sku: string
    raw: string
    applied: boolean
    warehouseApplied?: boolean
    channelApplied?: boolean
    error?: string
    /** IM.3.4 — original row inputs, so failed rows can be retried and
     *  history drill-downs show what was asked for. */
    quantity?: number
    channel?: string
    marketplace?: string
  }>
}

// ── Normalisation ─────────────────────────────────────────────────────────────

export function normalizeAlias(raw: string): string {
  return raw
    .toLowerCase()
    .trim()
    .replace(/\s+/g, ' ')
    .replace(/[^\w\s-]/g, '')
}

// ── Resolution ───────────────────────────────────────────────────────────────

interface ProductLookup {
  id: string
  sku: string
  name: string
  ean: string | null
  upc: string | null
  fnsku: string | null
  amazonAsin: string | null
}

interface ResolutionIndex {
  products: ProductLookup[]
  bySku: Map<string, ProductLookup>
  bySkuLower: Map<string, ProductLookup>
  byEan: Map<string, ProductLookup>
  byUpc: Map<string, ProductLookup>
  byAlias: Map<string, string>
  byChannelId: Map<string, string>
  productById: Map<string, ProductLookup>
}

// IM.3.1 — the wizard calls /resolve and then /preview (which re-resolves)
// back to back, so the full catalog + alias + channel-identity load ran twice
// per import. A short-TTL cache makes the second build free while keeping
// staleness bounded; alias writes invalidate it explicitly.
const RESOLUTION_INDEX_TTL_MS = 30 * 1000
let cachedIndex: { index: ResolutionIndex; builtAt: number } | null = null

export function invalidateResolutionIndex(): void {
  cachedIndex = null
}

async function buildResolutionIndex(): Promise<ResolutionIndex> {
  const now = Date.now()
  if (cachedIndex && now - cachedIndex.builtAt < RESOLUTION_INDEX_TTL_MS) {
    return cachedIndex.index
  }

  // Load all products (small catalog, ~279 for Xavia — single query is fine)
  const products = await prisma.product.findMany({
    select: { id: true, sku: true, name: true, ean: true, upc: true, fnsku: true, amazonAsin: true },
  })

  // Build lookup maps
  const bySku = new Map<string, ProductLookup>(products.map((p) => [p.sku, p]))
  const bySkuLower = new Map<string, ProductLookup>(products.map((p) => [p.sku.toLowerCase(), p]))
  const byEan = new Map<string, ProductLookup>()
  const byUpc = new Map<string, ProductLookup>()
  for (const p of products) {
    if (p.ean) byEan.set(p.ean.toLowerCase(), p)
    if (p.upc) byUpc.set(p.upc.toLowerCase(), p)
  }

  // Load all aliases
  const aliases = await prisma.skuAlias.findMany({
    select: { alias: true, productId: true },
  })
  const byAlias = new Map<string, string>(aliases.map((a) => [a.alias, a.productId]))
  const productById = new Map<string, ProductLookup>(products.map((p) => [p.id, p]))

  // IM.2 P2 — channel identities, so marketplace exports resolve directly:
  // eBay custom labels (shared-SKU memberships), FNSKU, ASIN. All batched;
  // maps are raw-lowercase → productId.
  const byChannelId = new Map<string, string>()
  const addChannelId = (key: string | null | undefined, productId: string | null | undefined) => {
    if (!key || !productId) return
    const k = key.trim().toLowerCase()
    if (k && !byChannelId.has(k)) byChannelId.set(k, productId)
  }
  const [memberships, amazonListings] = await Promise.all([
    prisma.sharedListingMembership.findMany({
      where: { status: 'ACTIVE', productId: { not: null } },
      select: { sku: true, productId: true },
    }),
    prisma.channelListing.findMany({
      where: { channel: 'AMAZON' },
      select: { productId: true, externalListingId: true, platformProductId: true },
    }),
  ])
  for (const m of memberships) addChannelId(m.sku, m.productId)
  for (const p of products) {
    addChannelId(p.fnsku, p.id)
    addChannelId(p.amazonAsin, p.id) // 264/273 products carry the child ASIN here
  }
  for (const cl of amazonListings) {
    addChannelId(cl.externalListingId, cl.productId) // child ASIN
    addChannelId(cl.platformProductId, cl.productId) // analytics ASIN key
  }

  const index: ResolutionIndex = { products, bySku, bySkuLower, byEan, byUpc, byAlias, byChannelId, productById }
  cachedIndex = { index, builtAt: now }
  return index
}

export async function resolveRows(rows: ImportRow[]): Promise<ResolvedRow[]> {
  const raws = rows.map((r) => r.raw.trim()).filter(Boolean)
  if (raws.length === 0) return []

  const { products, bySku, bySkuLower, byEan, byUpc, byAlias, byChannelId, productById } =
    await buildResolutionIndex()

  return rows.map((row): ResolvedRow => {
    const raw = row.raw.trim()
    const normalized = normalizeAlias(raw)

    // Tier 1: exact SKU
    const exactMatch = bySku.get(raw) ?? bySkuLower.get(raw.toLowerCase())
    if (exactMatch) {
      return {
        ...row,
        productId: exactMatch.id,
        productName: exactMatch.name,
        resolvedSku: exactMatch.sku,
        tier: 'EXACT',
        candidates: [],
      }
    }

    // Tier 2: alias
    const aliasProductId = byAlias.get(normalized)
    if (aliasProductId) {
      const p = productById.get(aliasProductId)
      if (p) {
        return {
          ...row,
          productId: p.id,
          productName: p.name,
          resolvedSku: p.sku,
          tier: 'ALIAS',
          candidates: [],
        }
      }
    }

    // Tier 3: channel identity (eBay custom label / FNSKU / ASIN)
    const channelProductId = byChannelId.get(raw.toLowerCase())
    if (channelProductId) {
      const p = productById.get(channelProductId)
      if (p) {
        return {
          ...row,
          productId: p.id,
          productName: p.name,
          resolvedSku: p.sku,
          tier: 'CHANNEL_SKU',
          candidates: [],
        }
      }
    }

    // Tier 4: barcode (EAN/UPC) — before fuzzy: exact identifiers must
    // never lose to a name guess
    const barcodeMatch = byEan.get(normalized) ?? byUpc.get(normalized)
    if (barcodeMatch) {
      return {
        ...row,
        productId: barcodeMatch.id,
        productName: barcodeMatch.name,
        resolvedSku: barcodeMatch.sku,
        tier: 'BARCODE',
        candidates: [],
      }
    }

    // Tier 5: fuzzy name (contains, case-insensitive), ambiguity-gated
    const nameLower = normalized
    const nameCandidates = products
      .filter((p) => {
        const pn = p.name.toLowerCase()
        return pn.includes(nameLower) || nameLower.includes(pn.slice(0, 8))
      })
      .map((p) => {
        // Simple scoring: longer overlap = better
        const pn = p.name.toLowerCase()
        const overlap = nameLower.split(' ').filter((w) => pn.includes(w) && w.length > 2).length
        return { productId: p.id, sku: p.sku, name: p.name, score: overlap }
      })
      .filter((c) => c.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, 5)

    // Gate: auto-accept only a clear winner (≥2 matched words AND strictly
    // ahead of the runner-up). Weak or tied scores stay UNRESOLVED with the
    // ranked candidates surfaced for one-click assignment in the UI.
    const top = nameCandidates[0]
    const runnerUp = nameCandidates[1]
    const clearWinner = top && top.score >= 2 && (!runnerUp || top.score > runnerUp.score)
    if (clearWinner) {
      const best = productById.get(top.productId)!
      return {
        ...row,
        productId: best.id,
        productName: best.name,
        resolvedSku: best.sku,
        tier: 'FUZZY_NAME',
        candidates: nameCandidates,
      }
    }

    // Unresolved (candidates ranked for the assign UI, possibly empty)
    return {
      ...row,
      productId: null,
      productName: null,
      resolvedSku: null,
      tier: 'UNRESOLVED',
      candidates: nameCandidates,
    }
  })
}

// ── Preview ───────────────────────────────────────────────────────────────────

export async function previewImport(opts: {
  rows: ImportRow[]
  locationCode: string
  mode: ImportMode
  target: ImportTarget
}): Promise<PreviewResult> {
  const { rows, locationCode, mode, target } = opts

  const location = await prisma.stockLocation.findUnique({
    where: { code: locationCode },
    select: { id: true, type: true, code: true },
  })
  if (!location) throw new Error(`Location ${locationCode} not found`)
  if (location.type === 'AMAZON_FBA') throw new Error('FBA locations are read-only')

  const resolved = await resolveRows(rows)

  // Batch-load current StockLevels
  const productIds = resolved.map((r) => r.productId).filter(Boolean) as string[]
  const stockLevels = await prisma.stockLevel.findMany({
    where: { locationId: location.id, productId: { in: productIds } },
    select: { productId: true, quantity: true, available: true },
  })
  const stockByProduct = new Map(stockLevels.map((sl) => [sl.productId, sl]))

  // Batch-load channel listings for CHANNEL/BOTH targets. One query for all
  // products; per-row channel/marketplace filters (a row's own columns)
  // apply in JS — the SAME filter apply uses, so preview never diverges.
  let channelListingsByProduct = new Map<string, Array<{ id: string; channel: string; marketplace: string; quantity: number | null; quantityOverride: number | null; listingStatus: string; fulfillmentMethod: string | null }>>()
  // IM.3.3 — preview mirrors apply's FBA exclusion, so what the preview
  // shows is exactly what apply writes (preview = apply invariant).
  const previewFbaBucket = new Map<string, number>()
  const previewProductFulfillment = new Map<string, string | null>()
  if (target !== 'WAREHOUSE') {
    const [cls, fbaLevels, productMeta] = await Promise.all([
      prisma.channelListing.findMany({
        where: {
          productId: { in: productIds },
          channel: { in: ['AMAZON', 'EBAY', 'SHOPIFY'] },
        },
        select: { id: true, productId: true, channel: true, marketplace: true, quantity: true, quantityOverride: true, listingStatus: true, fulfillmentMethod: true },
      }),
      prisma.stockLevel.findMany({
        where: { productId: { in: productIds }, location: { type: 'AMAZON_FBA' } },
        select: { productId: true, quantity: true },
      }),
      prisma.product.findMany({
        where: { id: { in: productIds } },
        select: { id: true, fulfillmentMethod: true },
      }),
    ])
    for (const cl of cls) {
      const existing = channelListingsByProduct.get(cl.productId) ?? []
      existing.push(cl)
      channelListingsByProduct.set(cl.productId, existing)
    }
    for (const lvl of fbaLevels) {
      previewFbaBucket.set(lvl.productId, (previewFbaBucket.get(lvl.productId) ?? 0) + lvl.quantity)
    }
    for (const p of productMeta) previewProductFulfillment.set(p.id, p.fulfillmentMethod)
  }

  let resolvedCount = 0, fuzzyCount = 0, unresolvedCount = 0, errorCount = 0, wouldUpdateCount = 0

  // Duplicate-SKU tracking: warehouse math previews SEQUENTIALLY (row 2 of
  // the same SKU starts from row 1's result — matching apply), and dup rows
  // get an explicit warning instead of silently misleading.
  const seenPerProduct = new Map<string, number>()
  const effectiveWarehouseQty = new Map<string, number>()

  const previewRows: PreviewRow[] = resolved.map((r): PreviewRow => {
    const warnings: string[] = []
    let error: string | null = null

    if (r.tier === 'UNRESOLVED') { unresolvedCount++; error = 'SKU not found — assign manually' }
    else if (r.tier === 'FUZZY_NAME') { fuzzyCount++ }
    else { resolvedCount++ }

    const dupIndex = r.productId ? (seenPerProduct.get(r.productId) ?? 0) : 0
    if (r.productId) seenPerProduct.set(r.productId, dupIndex + 1)
    if (dupIndex > 0) {
      warnings.push(
        mode === 'SET'
          ? `Duplicate SKU in file (row ${dupIndex + 1} for this product) — the LAST value wins`
          : `Duplicate SKU in file (row ${dupIndex + 1} for this product) — adjustments apply cumulatively`,
      )
    }

    const sl = r.productId ? stockByProduct.get(r.productId) : undefined
    const baseWarehouseQty = r.productId
      ? effectiveWarehouseQty.get(r.productId) ?? sl?.quantity ?? 0
      : null
    const currentWarehouseQty = sl?.quantity ?? (r.productId ? 0 : null)

    let wouldBeWarehouseQty: number | null = null
    if (baseWarehouseQty !== null && r.productId && target !== 'CHANNEL') {
      wouldBeWarehouseQty = mode === 'SET' ? r.quantity : baseWarehouseQty + r.quantity
      if (wouldBeWarehouseQty < 0) {
        error = `Would go negative (${baseWarehouseQty} + ${r.quantity} = ${wouldBeWarehouseQty})`
        errorCount++
      } else {
        effectiveWarehouseQty.set(r.productId, wouldBeWarehouseQty)
      }
      if (mode === 'ADJUST' && r.quantity === 0) {
        warnings.push('No change (quantity is 0)')
      }
    }

    // Channel preview — per-listing, honoring the row's own channel /
    // marketplace columns and skipping ENDED (exactly what apply does)
    const cls = r.productId ? (channelListingsByProduct.get(r.productId) ?? []) : []
    const matchedCls = cls
      .filter((cl) => cl.listingStatus !== 'ENDED')
      // IM.3.3 — same FBA exclusion as apply (FBA listings are Amazon-managed)
      .filter((cl) => !r.productId || resolveListingFulfillmentMethod({
        listingFulfillmentMethod: cl.fulfillmentMethod,
        channel: cl.channel,
        fbaBucket: previewFbaBucket.get(r.productId) ?? 0,
        productFulfillmentMethod: previewProductFulfillment.get(r.productId) ?? null,
      }) === 'FBM')
      .filter((cl) => !r.channel || cl.channel === r.channel)
      .filter((cl) => !r.marketplace || cl.marketplace === r.marketplace)

    const channelListings: ChannelListingPreview[] = target !== 'WAREHOUSE'
      ? matchedCls.map((cl) => {
          const current = cl.quantityOverride ?? cl.quantity ?? 0
          const rawWouldBe = mode === 'SET' ? r.quantity : current + r.quantity
          return {
            id: cl.id,
            channel: cl.channel,
            marketplace: cl.marketplace,
            current,
            wouldBe: Math.max(0, rawWouldBe),
            clamped: rawWouldBe < 0,
          }
        })
      : []

    if (target !== 'WAREHOUSE' && r.productId && !error) {
      if (channelListings.length === 0) {
        const filterDesc = [r.channel, r.marketplace].filter(Boolean).join('/')
        const msg = `No active channel listing matches${filterDesc ? ` (${filterDesc})` : ''}`
        if (target === 'CHANNEL') { error = msg; errorCount++ }
        else warnings.push(`${msg} — only the warehouse will update`)
      }
      if (channelListings.some((c) => c.clamped)) {
        warnings.push('Channel quantity would go negative — will be clamped to 0')
      }
    }

    const currentChannelQty = channelListings[0]?.current ?? null
    const wouldBeChannelQty = channelListings[0]?.wouldBe ?? null

    if (r.tier === 'FUZZY_NAME') warnings.push('Fuzzy match — please verify this is the correct product')
    if (!error && r.productId) wouldUpdateCount++

    return {
      ...r,
      currentWarehouseQty,
      wouldBeWarehouseQty,
      currentChannelQty,
      wouldBeChannelQty,
      channelListings,
      warnings,
      error,
    }
  })

  return {
    rows: previewRows,
    resolved: resolvedCount,
    fuzzy: fuzzyCount,
    unresolved: unresolvedCount,
    errors: errorCount,
    wouldUpdate: wouldUpdateCount,
  }
}

// ── Draft job / idempotency (IM.2 P4) ────────────────────────────────────────

export class ImportAlreadyAppliedError extends Error {
  constructor() {
    super('This import was already applied (or its draft expired) — re-run Preview to start a fresh one')
    this.name = 'ImportAlreadyAppliedError'
  }
}

/**
 * Create (or refresh) the DRAFT StockImportJob backing a previewed import.
 * The wizard gets the jobId at PREVIEW time; apply then consumes the DRAFT
 * exactly once, so a double-click / retry can never apply stock twice.
 * Re-previews reuse the same draft row instead of littering history.
 */
export async function ensureDraftImportJob(opts: {
  jobId?: string
  filename?: string
  fileKind?: string
  locationCode: string
  mode: ImportMode
  target: ImportTarget
  totalRows: number
}): Promise<string> {
  const { jobId, filename, fileKind, locationCode, mode, target, totalRows } = opts
  if (jobId) {
    const updated = await prisma.stockImportJob.updateMany({
      where: { id: jobId, status: 'DRAFT' },
      data: { filename: filename ?? null, fileKind: fileKind ?? null, locationCode, mode, target, totalRows },
    })
    if (updated.count === 1) return jobId
    // stale or already-consumed draft — mint a fresh one below
  }
  const job = await prisma.stockImportJob.create({
    data: {
      filename: filename ?? null,
      fileKind: fileKind ?? null,
      locationCode,
      mode,
      target,
      totalRows,
      status: 'DRAFT',
    },
  })
  return job.id
}

// ── Apply (IM.3.1 — batched set-based engine) ────────────────────────────────
//
// The IM.1/IM.2 engine applied rows one at a time: each row opened its own
// transaction and re-ran the full per-product cascade (~15-17 queries/row —
// a 500-row file cost ~8,500 sequential queries inside one HTTP request).
// This engine plans everything in memory from batched pre-reads, then writes
// in chunked transactions with set-based (unnest) updates:
//
//   plan  — per-product movement chains (dup-SKU rows stay sequentially
//           correct), negative guards, channel-listing arithmetic, and ONE
//           cascade per product computed at FINAL state (not one per row).
//   write — chunks of NEXUS_IMPORT_CHUNK_PRODUCTS products (default 50);
//           per chunk one transaction. A failed chunk falls back to
//           per-product transactions so one bad product fails alone and
//           per-row error reporting survives.
//   after — one BullMQ enqueue pass, one stockout check and one read-cache
//           refresh per product (not per row).
//
// Semantics preserved from the per-row engine: movement audit chain
// (quantityBefore/balanceAfter per row), SET-as-delta vs live base, ADJUST
// cumulative with the same negative-guard error text, channel clamp at 0,
// pinOverride, ENDED exclusion, coalesce-before-insert, hold windows and
// payload shapes. Deliberate improvements: BOTH-target listings are written
// ONCE (the explicit channel value wins — the old engine wrote them twice
// and the second write won), and only the FINAL queue row per listing is
// inserted (the old engine inserted N and cancelled N−1 via coalesce).

// Mirrors stock-movement.service DEFAULT_HOLD_MS for cascade-sourced rows.
const CASCADE_HOLD_MS = 30 * 1000
// SyncChannel enum values OutboundSyncQueue.targetChannel accepts.
const VALID_SYNC_TARGETS = new Set(['AMAZON', 'EBAY', 'SHOPIFY', 'WOOCOMMERCE'])
// Channels the explicit CHANNEL/BOTH writer targets (parity with IM.2).
const EXPLICIT_CHANNELS = new Set(['AMAZON', 'EBAY', 'SHOPIFY'])

export interface ApplyProgress {
  total: number
  processed: number
  succeeded: number
  failed: number
  skipped: number
}

interface RowSlot {
  row: PreviewRow
  skipped: boolean
  warehouseApplied: boolean
  channelApplied: boolean
  error?: string
}

interface PlannedMovement {
  change: number
  quantityBefore: number
  balanceAfter: number
  notes: string
}

interface PlannedQueueRow {
  id: string
  /** IMPORT rows enqueue with source STOCK_IMPORT; CASCADE rows (incl.
   *  shared-SKU fanout) with source STOCK_MOVEMENT — parity with IM.2. */
  kind: 'IMPORT' | 'CASCADE'
  productId: string
  data: Prisma.OutboundSyncQueueCreateManyInput
}

interface ProductPlan {
  productId: string
  sku: string
  rowSlots: RowSlot[]
  movements: PlannedMovement[]
  stockLevelId: string | null
  baseQty: number
  reserved: number
  /** Effective warehouse qty as the movement chain advances (= final qty). */
  finalQty: number
  newTotalStock: number | null
  cascadeWrites: Array<{ listingId: string; masterQuantity: number; quantity: number }>
  snapshotWrites: Array<{ listingId: string; masterQuantity: number }>
  explicitWrites: Array<{ listingId: string; quantity: number; masterQuantity: number | null }>
  queueRows: PlannedQueueRow[]
}

export interface ApplyImportOptions {
  rows: PreviewRow[]
  locationCode: string
  mode: ImportMode
  target: ImportTarget
  filename?: string
  fileKind?: string
  /**
   * IM.2 P3 — when true, CHANNEL/BOTH writes also pin quantityOverride +
   * followMasterQuantity=false (listing stops following the warehouse pool).
   * Default false: a one-shot push that leaves pool-following intact.
   */
  pinOverride?: boolean
  /**
   * IM.2 P4 — DRAFT job id from the preview step. When present, apply
   * atomically consumes it (DRAFT→APPLYING); a second apply of the same
   * draft throws ImportAlreadyAppliedError instead of double-writing stock.
   */
  jobId?: string
  /**
   * IM.3.1 — chunk-level progress hook (feeds the IM.3.2 async progress
   * endpoint). Called after planning and after each committed chunk;
   * errors in the callback never affect the apply.
   */
  onProgress?: (p: ApplyProgress) => void | Promise<void>
  /**
   * IM.3.2 — cooperative cancel. Checked between chunks; already-committed
   * chunks stay committed, unwritten rows finalize as 'Cancelled before
   * write' and the job closes as CANCELLED.
   */
  shouldAbort?: () => boolean
  /**
   * IM.3.3 — session identity of the operator applying the import (email).
   * Stored on StockImportJob.createdBy; movement rows keep the stable
   * 'bulk-import' actor and link back via referenceId=jobId.
   */
  actor?: string | null
}

/**
 * IM.3.2 — validate + claim the job, then hand back a `run` closure so the
 * route can respond immediately and execute the engine detached (async
 * apply). Early failures (unknown location, FBA guard, already-applied
 * draft) throw HERE, synchronously in the request. `run` finalizes the job
 * row on every path — success, partial, cancel, or crash.
 */
export async function beginApplyImport(
  opts: ApplyImportOptions,
): Promise<{ jobId: string; totalRows: number; run: () => Promise<ApplyResult> }> {
  const { rows, locationCode, mode, target, filename, fileKind, pinOverride = false, onProgress, shouldAbort, actor } = opts

  const location = await prisma.stockLocation.findUnique({
    where: { code: locationCode },
    select: { id: true, type: true },
  })
  if (!location) throw new Error(`Location ${locationCode} not found`)
  if (location.type === 'AMAZON_FBA') throw new Error('FBA locations are read-only')

  // Audit job: consume the preview's DRAFT exactly once, or (legacy callers
  // without a draft) create the row at apply time.
  let jobId: string
  if (opts.jobId) {
    const claimed = await prisma.stockImportJob.updateMany({
      where: { id: opts.jobId, status: 'DRAFT' },
      data: {
        status: 'APPLYING',
        locationCode,
        mode,
        target,
        totalRows: rows.length,
        startedAt: new Date(),
        progressAt: new Date(),
        processedRows: 0,
        ...(actor ? { createdBy: actor } : {}),
        ...(filename !== undefined ? { filename } : {}),
        ...(fileKind !== undefined ? { fileKind } : {}),
      },
    })
    if (claimed.count !== 1) throw new ImportAlreadyAppliedError()
    jobId = opts.jobId
  } else {
    const job = await prisma.stockImportJob.create({
      data: {
        filename: filename ?? null,
        fileKind: fileKind ?? null,
        locationCode,
        mode,
        target,
        totalRows: rows.length,
        status: 'APPLYING',
        startedAt: new Date(),
        progressAt: new Date(),
        ...(actor ? { createdBy: actor } : {}),
      },
    })
    jobId = job.id
  }

  const run = async (): Promise<ApplyResult> => {
    try {
      return await executeApplyImport({ rows, mode, target, pinOverride, jobId, location, onProgress, shouldAbort })
    } catch (err) {
      // Unexpected crash — finalize honestly so the job can never stick in
      // APPLYING (boot sweep + progress-poll heal are the backstops).
      const msg = err instanceof Error ? err.message : String(err)
      await prisma.stockImportJob
        .updateMany({
          where: { id: jobId, status: 'APPLYING' },
          data: { status: 'FAILED', errorSummary: msg.slice(0, 500), appliedAt: new Date() },
        })
        .catch(() => {})
      throw err
    }
  }
  return { jobId, totalRows: rows.length, run }
}

/** Sync entrypoint (scripts/tests): begin + run in one call. */
export async function applyImport(opts: ApplyImportOptions): Promise<ApplyResult> {
  const { run } = await beginApplyImport(opts)
  return run()
}

async function executeApplyImport(args: {
  rows: PreviewRow[]
  mode: ImportMode
  target: ImportTarget
  pinOverride: boolean
  jobId: string
  location: { id: string; type: string }
  onProgress?: (p: ApplyProgress) => void | Promise<void>
  shouldAbort?: () => boolean
}): Promise<ApplyResult> {
  const { rows, mode, target, pinOverride, jobId, location, onProgress, shouldAbort } = args

  // ── Row slots (original order — results are emitted in file order) ──────────
  const slots: RowSlot[] = rows.map((row) => {
    if (row.error || !row.productId || !row.resolvedSku) {
      return { row, skipped: true, warehouseApplied: false, channelApplied: false, error: row.error ?? 'unresolved' }
    }
    if (!Number.isFinite(row.quantity) || !Number.isInteger(row.quantity)) {
      return { row, skipped: false, warehouseApplied: false, channelApplied: false, error: `Quantity must be a whole number (got ${row.quantity})` }
    }
    if (Math.abs(row.quantity) > 1_000_000) {
      return { row, skipped: false, warehouseApplied: false, channelApplied: false, error: `Quantity out of range (got ${row.quantity})` }
    }
    return { row, skipped: false, warehouseApplied: false, channelApplied: false }
  })
  const applicable = slots.filter((s) => !s.skipped && !s.error)
  const productIds = [...new Set(applicable.map((s) => s.row.productId as string))]

  const wantsWarehouse = target !== 'CHANNEL'
  const wantsChannel = target !== 'WAREHOUSE'

  // ── Batched pre-reads (fixed query count regardless of row count) ───────────
  const [locLevels, allLevels, productMeta, allListings, memberships] = await Promise.all([
    wantsWarehouse && productIds.length > 0
      ? prisma.stockLevel.findMany({
          where: { locationId: location.id, productId: { in: productIds }, variationId: null },
          select: { id: true, productId: true, quantity: true, reserved: true },
        })
      : [],
    // IM.3.3 — loaded for CHANNEL targets too: the explicit writer needs the
    // per-product FBA bucket to resolve (and exclude) FBA-backed listings.
    productIds.length > 0
      ? prisma.stockLevel.findMany({
          where: { productId: { in: productIds } },
          select: {
            id: true, productId: true, locationId: true, variationId: true,
            quantity: true, available: true, location: { select: { type: true } },
          },
        })
      : [],
    productIds.length > 0
      ? prisma.product.findMany({
          where: { id: { in: productIds } },
          select: { id: true, sku: true, fulfillmentMethod: true },
        })
      : [],
    productIds.length > 0
      ? prisma.channelListing.findMany({
          where: { productId: { in: productIds } },
          select: {
            id: true, productId: true, channel: true, region: true, marketplace: true,
            externalListingId: true, quantity: true, masterQuantity: true, stockBuffer: true,
            followMasterQuantity: true, fulfillmentMethod: true, quantityOverride: true,
            listingStatus: true,
          },
        })
      : [],
    wantsWarehouse && productIds.length > 0
      ? prisma.sharedListingMembership.findMany({
          where: { productId: { in: productIds }, status: 'ACTIVE' },
          select: { sku: true, itemId: true, marketplace: true, productId: true, lastQtyPushed: true },
        })
      : [],
  ])

  const locLevelByProduct = new Map(locLevels.map((l) => [l.productId, l] as const))
  const metaByProduct = new Map(productMeta.map((p) => [p.id, p] as const))
  const levelsByProduct = new Map<string, typeof allLevels>()
  for (const lvl of allLevels) {
    const arr = levelsByProduct.get(lvl.productId)
    if (arr) arr.push(lvl)
    else levelsByProduct.set(lvl.productId, [lvl])
  }
  const listingsByProduct = new Map<string, typeof allListings>()
  for (const cl of allListings) {
    const arr = listingsByProduct.get(cl.productId)
    if (arr) arr.push(cl)
    else listingsByProduct.set(cl.productId, [cl])
  }
  const membershipsByProduct = new Map<string, typeof memberships>()
  for (const m of memberships) {
    if (!m.productId) continue
    const arr = membershipsByProduct.get(m.productId)
    if (arr) arr.push(m)
    else membershipsByProduct.set(m.productId, [m])
  }
  // IM.3.3 — per-product FBA bucket for listing-method resolution in the
  // explicit channel path (cascade computes its own inline, unchanged).
  const fbaBucketByProduct = new Map<string, number>()
  for (const lvl of allLevels) {
    if (lvl.location?.type === 'AMAZON_FBA') {
      fbaBucketByProduct.set(lvl.productId, (fbaBucketByProduct.get(lvl.productId) ?? 0) + lvl.quantity)
    }
  }

  // ── Plan: per-product movement chains + channel arithmetic (in memory) ──────
  const plans = new Map<string, ProductPlan>()
  const planFor = (productId: string): ProductPlan => {
    let plan = plans.get(productId)
    if (!plan) {
      const lvl = locLevelByProduct.get(productId)
      plan = {
        productId,
        sku: metaByProduct.get(productId)?.sku ?? '?',
        rowSlots: [],
        movements: [],
        stockLevelId: lvl?.id ?? null,
        baseQty: lvl?.quantity ?? 0,
        reserved: lvl?.reserved ?? 0,
        finalQty: lvl?.quantity ?? 0,
        newTotalStock: null,
        cascadeWrites: [],
        snapshotWrites: [],
        explicitWrites: [],
        queueRows: [],
      }
      plans.set(productId, plan)
    }
    return plan
  }

  // Explicit CHANNEL/BOTH targets: listingId → owning plan + listing row.
  // Populated in file order; the FINAL effective value per listing is what
  // gets written and enqueued (the per-row engine wrote every intermediate
  // value and coalesced the queue rows — same net outcome, one write).
  const listingEffectiveQty = new Map<string, number>()
  const explicitTargets = new Map<string, { plan: ProductPlan; listing: (typeof allListings)[number] }>()

  for (const slot of slots) {
    if (slot.skipped || slot.error) continue
    const row = slot.row
    const productId = row.productId as string

    // IM.3.3 — server-side identity re-validation. Apply consumes the
    // client's preview rows; the (productId, resolvedSku) pair must still
    // match the live catalog or the row is refused (tampered payload, or a
    // product renamed/deleted since preview).
    const identity = metaByProduct.get(productId)
    if (!identity || identity.sku !== row.resolvedSku) {
      slot.error = identity
        ? `Row identity mismatch (SKU is now '${identity.sku}') — re-run Preview`
        : 'Product no longer exists — re-run Preview'
      continue
    }

    const plan = planFor(productId)
    plan.rowSlots.push(slot)

    // ── Warehouse chain (dup-SKU rows stay sequentially correct) ──
    if (wantsWarehouse) {
      if (mode === 'SET') {
        const delta = row.quantity - plan.finalQty
        if (row.quantity < 0) {
          slot.error =
            `applyStockMovement: would drive StockLevel quantity negative ` +
            `(product=${productId} location=${location.id} ` +
            `before=${plan.finalQty} change=${delta})`
          continue
        }
        if (delta !== 0) {
          plan.movements.push({
            change: delta,
            quantityBefore: plan.finalQty,
            balanceAfter: row.quantity,
            notes: row.notes ?? `[SET ${row.quantity}] ${row.raw}`,
          })
          plan.finalQty = row.quantity
        }
        slot.warehouseApplied = true
      } else if (row.quantity !== 0) {
        const next = plan.finalQty + row.quantity
        if (next < 0) {
          slot.error =
            `applyStockMovement: would drive StockLevel quantity negative ` +
            `(product=${productId} location=${location.id} ` +
            `before=${plan.finalQty} change=${row.quantity})`
          continue
        }
        plan.movements.push({
          change: row.quantity,
          quantityBefore: plan.finalQty,
          balanceAfter: next,
          notes: row.notes ?? `[ADJUST ${row.quantity > 0 ? '+' : ''}${row.quantity}] ${row.raw}`,
        })
        plan.finalQty = next
        slot.warehouseApplied = true
      }
      // ADJUST of 0 is a valid no-op (parity: no movement, row still succeeds)
    }

    // ── Channel listing arithmetic (explicit CHANNEL/BOTH writes) ──
    if (wantsChannel) {
      const cls = (listingsByProduct.get(productId) ?? [])
        .filter((cl) => cl.listingStatus !== 'ENDED')
        .filter((cl) => EXPLICIT_CHANNELS.has(cl.channel))
        // IM.3.3 — FBA-backed listings are Amazon-managed: never write their
        // local quantity (the old engine wrote it and relied on the dispatch
        // guard to block only the marketplace push).
        .filter((cl) => resolveListingFulfillmentMethod({
          listingFulfillmentMethod: cl.fulfillmentMethod,
          channel: cl.channel,
          fbaBucket: fbaBucketByProduct.get(productId) ?? 0,
          productFulfillmentMethod: metaByProduct.get(productId)?.fulfillmentMethod ?? null,
        }) === 'FBM')
        .filter((cl) => !row.channel || cl.channel === row.channel)
        .filter((cl) => !row.marketplace || cl.marketplace === row.marketplace)
      if (cls.length === 0) {
        const filterDesc = [row.channel, row.marketplace].filter(Boolean).join('/')
        const msg = `No active channel listing matches${filterDesc ? ` (${filterDesc})` : ''}`
        if (target === 'CHANNEL') slot.error = msg
        // BOTH: warehouse already applied — surfaced via channelApplied=false
      } else {
        for (const cl of cls) {
          const current = listingEffectiveQty.get(cl.id) ?? cl.quantityOverride ?? cl.quantity ?? 0
          const newQty = Math.max(0, mode === 'SET' ? row.quantity : current + row.quantity)
          listingEffectiveQty.set(cl.id, newQty)
          explicitTargets.set(cl.id, { plan, listing: cl })
        }
        slot.channelApplied = true
      }
    }
  }

  // Per-product explicit-listing id set (the cascade must not double-write
  // these — the explicit channel value wins, exactly like the old engine's
  // channel block overwriting the cascade's value).
  const explicitIdsByProduct = new Map<string, Set<string>>()
  for (const [listingId, t] of explicitTargets) {
    const set = explicitIdsByProduct.get(t.plan.productId) ?? new Set<string>()
    set.add(listingId)
    explicitIdsByProduct.set(t.plan.productId, set)
  }

  const holdUntil = new Date(Date.now() + IMPORT_HOLD_MS)

  // ── Plan: ONE cascade per product at FINAL state ────────────────────────────
  for (const plan of plans.values()) {
    if (!wantsWarehouse || plan.movements.length === 0) continue
    const { productId } = plan
    const meta = metaByProduct.get(productId)
    const explicitIds = explicitIdsByProduct.get(productId) ?? new Set<string>()

    // Recompute totalStock + pools in memory, substituting this import's
    // final qty for the import-location row (recomputeProductTotalStock /
    // cascadeQuantityToListings parity: WAREHOUSE-only pool, FBA bucket).
    let total = 0
    let warehouseAvailable = 0
    let fbaBucket = 0
    let sawImportRow = false
    for (const lvl of levelsByProduct.get(productId) ?? []) {
      const isImportRow = lvl.locationId === location.id && lvl.variationId === null
      if (isImportRow) sawImportRow = true
      const qty = isImportRow ? plan.finalQty : lvl.quantity
      const avail = isImportRow ? plan.finalQty - plan.reserved : lvl.available
      if (lvl.location?.type === 'WAREHOUSE') {
        total += qty
        warehouseAvailable += avail
      } else if (lvl.location?.type === 'AMAZON_FBA') {
        fbaBucket += lvl.quantity
      }
    }
    if (!sawImportRow && location.type === 'WAREHOUSE') {
      // Level row doesn't exist yet — the chunk write will create it.
      total += plan.finalQty
      warehouseAvailable += plan.finalQty
    }
    plan.newTotalStock = total
    const netChange = plan.finalQty - plan.baseQty

    for (const listing of listingsByProduct.get(productId) ?? []) {
      if (explicitIds.has(listing.id)) continue // explicit value wins (BOTH)
      // AS.5 — cascade parity: same dispatch-guard-aligned resolver as
      // cascadeQuantityToListings (FBA-signal veto for AMAZON listings).
      const method = resolveCascadePushMethod({
        listingFulfillmentMethod: listing.fulfillmentMethod,
        channel: listing.channel,
        fbaBucket,
        productFulfillmentMethod: meta?.fulfillmentMethod ?? null,
      })
      const newListingQty =
        listing.followMasterQuantity && method === 'FBM'
          ? computeAvailableToPublish({
              fulfillmentMethod: 'FBM',
              warehouseAvailable,
              fbaSellable: 0,
              stockBuffer: listing.stockBuffer ?? 0,
            }).available
          : null
      if (newListingQty != null && newListingQty !== listing.quantity) {
        plan.cascadeWrites.push({ listingId: listing.id, masterQuantity: total, quantity: newListingQty })
        if (VALID_SYNC_TARGETS.has(listing.channel)) {
          plan.queueRows.push({
            id: randomUUID(),
            kind: 'CASCADE',
            productId,
            data: {
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
                masterQuantity: total,
                stockBuffer: listing.stockBuffer ?? 0,
                reason: 'MANUAL_ADJUSTMENT',
                change: netChange,
                referenceType: 'BulkImport',
                referenceId: jobId,
              },
            },
          })
        }
      } else if (listing.masterQuantity !== total) {
        plan.snapshotWrites.push({ listingId: listing.id, masterQuantity: total })
      }
    }

    // Shared-SKU eBay fan-out — once per product at the final pool value (the
    // per-row engine enqueued one batch per row; the dispatcher's no-op guard
    // made the extras harmless but wasteful).
    const shared = membershipsByProduct.get(productId) ?? []
    if (shared.length > 0) {
      const capped = computeAvailableToPublish({
        fulfillmentMethod: 'FBM',
        warehouseAvailable,
        fbaSellable: 0,
        stockBuffer: 0, // shared listings have no per-listing ChannelListing buffer (yet)
      }).available
      for (const fanoutRow of buildSharedFanoutRows(shared as Array<SharedMembershipRow & { lastQtyPushed: number | null }>, () => capped, holdUntil)) {
        plan.queueRows.push({
          id: randomUUID(),
          kind: 'CASCADE',
          productId,
          data: { ...fanoutRow, payload: fanoutRow.payload as unknown as Prisma.InputJsonValue } as Prisma.OutboundSyncQueueCreateManyInput,
        })
      }
    }
  }

  // ── Plan: explicit CHANNEL/BOTH writes — final effective value per listing ──
  for (const [listingId, t] of explicitTargets) {
    const finalQty = listingEffectiveQty.get(listingId)
    if (finalQty === undefined) continue
    // BOTH folds the cascade's masterQuantity snapshot into the explicit
    // write; CHANNEL-only never touches masterQuantity (parity with IM.2).
    const masterQuantity = target === 'BOTH' ? t.plan.newTotalStock : null
    t.plan.explicitWrites.push({ listingId, quantity: finalQty, masterQuantity })
    t.plan.queueRows.push({
      id: randomUUID(),
      kind: 'IMPORT',
      productId: t.plan.productId,
      data: {
        productId: t.plan.productId,
        channelListingId: listingId,
        targetChannel: t.listing.channel as any,
        targetRegion: t.listing.region,
        syncStatus: 'PENDING' as any,
        syncType: 'QUANTITY_UPDATE',
        holdUntil,
        externalListingId: t.listing.externalListingId,
        maxRetries: 3,
        payload: {
          source: 'STOCK_IMPORT',
          productId: t.plan.productId,
          channel: t.listing.channel,
          marketplace: t.listing.marketplace,
          quantity: finalQty,
          oldQuantity: t.listing.quantity,
          pinOverride,
          reason: 'MANUAL_ADJUSTMENT',
          referenceType: 'BulkImport',
          referenceId: jobId,
          // IM.3.4 — full before-state so a batch revert can restore the
          // listing exactly (incl. pin state) instead of guessing.
          prior: {
            quantity: t.listing.quantity,
            quantityOverride: t.listing.quantityOverride,
            followMasterQuantity: t.listing.followMasterQuantity,
          },
        },
      },
    })
  }

  // ── Write: chunked transactions with set-based updates ──────────────────────
  const planList = [...plans.values()]
  const failedProducts = new Set<string>()
  const CHUNK_PRODUCTS = Math.max(1, Math.min(200, Number(process.env.NEXUS_IMPORT_CHUNK_PRODUCTS) || 50))

  const writeChunk = async (tx: Prisma.TransactionClient, chunk: ProductPlan[]) => {
    // 1. StockLevel — set-based update for existing rows, createMany for new
    const slUpdates = chunk.filter((p) => p.movements.length > 0 && p.stockLevelId)
    if (slUpdates.length > 0) {
      const ids = slUpdates.map((p) => p.stockLevelId as string)
      const qtys = slUpdates.map((p) => p.finalQty)
      await tx.$executeRaw`
        UPDATE "StockLevel" AS sl
        SET quantity = u.qty,
            available = u.qty - sl.reserved,
            "lastSyncedAt" = now(),
            "lastUpdatedAt" = now()
        FROM (SELECT unnest(${ids}::text[]) AS id, unnest(${qtys}::int[]) AS qty) AS u
        WHERE sl.id = u.id`
    }
    const slCreates = chunk.filter((p) => p.movements.length > 0 && !p.stockLevelId)
    if (slCreates.length > 0) {
      await tx.stockLevel.createMany({
        data: slCreates.map((p) => ({
          locationId: location.id,
          productId: p.productId,
          variationId: null,
          quantity: p.finalQty,
          reserved: 0,
          available: p.finalQty,
          syncStatus: 'SYNCED',
          lastSyncedAt: new Date(),
        })),
      })
    }

    // 2. StockMovement audit rows — one per applied row, chain preserved
    const movementRows = chunk.flatMap((p) =>
      p.movements.map((m) => ({
        productId: p.productId,
        variationId: null,
        warehouseId: null,
        locationId: location.id,
        change: m.change,
        balanceAfter: m.balanceAfter,
        quantityBefore: m.quantityBefore,
        reason: 'MANUAL_ADJUSTMENT' as const,
        referenceType: 'BulkImport',
        referenceId: jobId,
        notes: m.notes,
        actor: 'bulk-import',
      })),
    )
    if (movementRows.length > 0) await tx.stockMovement.createMany({ data: movementRows })

    // 3. Product.totalStock (recomputed in memory — WAREHOUSE-only sum)
    const totals = chunk.filter((p) => p.movements.length > 0 && p.newTotalStock != null)
    if (totals.length > 0) {
      const ids = totals.map((p) => p.productId)
      const values = totals.map((p) => p.newTotalStock as number)
      await tx.$executeRaw`
        UPDATE "Product" AS p
        SET "totalStock" = u.total, "updatedAt" = now()
        FROM (SELECT unnest(${ids}::text[]) AS id, unnest(${values}::int[]) AS total) AS u
        WHERE p.id = u.id`
    }

    // 4. ChannelListing writes — cascade / snapshot-only / explicit
    const cascades = chunk.flatMap((p) => p.cascadeWrites)
    if (cascades.length > 0) {
      const ids = cascades.map((c) => c.listingId)
      const mqs = cascades.map((c) => c.masterQuantity)
      const qtys = cascades.map((c) => c.quantity)
      await tx.$executeRaw`
        UPDATE "ChannelListing" AS cl
        SET "masterQuantity" = u.mq,
            quantity = u.qty,
            "lastSyncStatus" = 'PENDING',
            "lastSyncedAt" = NULL,
            version = cl.version + 1,
            "updatedAt" = now()
        FROM (SELECT unnest(${ids}::text[]) AS id, unnest(${mqs}::int[]) AS mq, unnest(${qtys}::int[]) AS qty) AS u
        WHERE cl.id = u.id`
    }
    const snapshots = chunk.flatMap((p) => p.snapshotWrites)
    if (snapshots.length > 0) {
      const ids = snapshots.map((s) => s.listingId)
      const mqs = snapshots.map((s) => s.masterQuantity)
      await tx.$executeRaw`
        UPDATE "ChannelListing" AS cl
        SET "masterQuantity" = u.mq, "updatedAt" = now()
        FROM (SELECT unnest(${ids}::text[]) AS id, unnest(${mqs}::int[]) AS mq) AS u
        WHERE cl.id = u.id`
    }
    const explicits = chunk.flatMap((p) => p.explicitWrites)
    if (explicits.length > 0) {
      const ids = explicits.map((e) => e.listingId)
      const qtys = explicits.map((e) => e.quantity)
      const mqs = explicits.map((e) => e.masterQuantity)
      if (pinOverride) {
        await tx.$executeRaw`
          UPDATE "ChannelListing" AS cl
          SET quantity = u.qty,
              "masterQuantity" = COALESCE(u.mq, cl."masterQuantity"),
              "quantityOverride" = u.qty,
              "followMasterQuantity" = false,
              "lastSyncStatus" = 'PENDING',
              "lastSyncedAt" = NULL,
              version = cl.version + 1,
              "updatedAt" = now()
          FROM (SELECT unnest(${ids}::text[]) AS id, unnest(${qtys}::int[]) AS qty, unnest(${mqs}::int[]) AS mq) AS u
          WHERE cl.id = u.id`
      } else {
        await tx.$executeRaw`
          UPDATE "ChannelListing" AS cl
          SET quantity = u.qty,
              "masterQuantity" = COALESCE(u.mq, cl."masterQuantity"),
              "lastSyncStatus" = 'PENDING',
              "lastSyncedAt" = NULL,
              version = cl.version + 1,
              "updatedAt" = now()
          FROM (SELECT unnest(${ids}::text[]) AS id, unnest(${qtys}::int[]) AS qty, unnest(${mqs}::int[]) AS mq) AS u
          WHERE cl.id = u.id`
      }
    }

    // 5. Coalesce superseded PENDING quantity pushes, then insert fresh rows.
    // Queue-row ids are pre-generated so no read-back query is needed.
    const queueRows = chunk.flatMap((p) => p.queueRows)
    const coalesceIds = queueRows
      .map((q) => q.data.channelListingId)
      .filter((id): id is string => Boolean(id))
    if (coalesceIds.length > 0) await coalescePendingQuantityRows(tx, coalesceIds)
    if (queueRows.length > 0) {
      await tx.outboundSyncQueue.createMany({
        data: queueRows.map((q) => ({ ...q.data, id: q.id })),
      })
    }
  }

  const skippedCount = slots.filter((s) => s.skipped).length
  // Rows rejected by the integer precheck never enter a plan, so the chunk
  // loop can't count them — fold them into the baseline so progress reaches
  // total. (Planning-stage errors DO sit inside plan.rowSlots.)
  const plannedSlots = new Set(planList.flatMap((p) => p.rowSlots))
  const precheckFailed = slots.filter((s) => !s.skipped && s.error && !plannedSlots.has(s)).length
  let processedRows = skippedCount + precheckFailed
  let doneSucceeded = 0
  let doneFailed = precheckFailed
  const report = async () => {
    if (!onProgress) return
    try {
      await onProgress({
        total: rows.length,
        processed: processedRows,
        succeeded: doneSucceeded,
        failed: doneFailed,
        skipped: skippedCount,
      })
    } catch {
      /* progress must never affect the apply */
    }
  }
  await report()

  let cancelled = false
  const writtenPlans = new Set<ProductPlan>()
  for (let i = 0; i < planList.length; i += CHUNK_PRODUCTS) {
    if (shouldAbort?.()) {
      cancelled = true
      break
    }
    const chunk = planList.slice(i, i + CHUNK_PRODUCTS)
    try {
      await prisma.$transaction((tx) => writeChunk(tx, chunk), { timeout: 30_000, maxWait: 10_000 })
    } catch (chunkErr) {
      // Isolate: retry each product alone so one bad product fails alone and
      // per-row error reporting survives (the batch tx rolled back atomically).
      logger.warn('stock-import: chunk write failed — retrying per product', {
        products: chunk.length,
        error: chunkErr instanceof Error ? chunkErr.message : String(chunkErr),
      })
      for (const plan of chunk) {
        try {
          await prisma.$transaction((tx) => writeChunk(tx, [plan]), { timeout: 15_000, maxWait: 10_000 })
        } catch (productErr) {
          const msg = productErr instanceof Error ? productErr.message : String(productErr)
          failedProducts.add(plan.productId)
          for (const slot of plan.rowSlots) {
            if (!slot.error) {
              slot.error = msg
              slot.warehouseApplied = false
              slot.channelApplied = false
            }
          }
          logger.error('stock-import: product write failed', { productId: plan.productId, sku: plan.sku, error: msg })
        }
      }
    }
    for (const plan of chunk) {
      writtenPlans.add(plan)
      processedRows += plan.rowSlots.length
      doneSucceeded += plan.rowSlots.filter((s) => !s.error).length
      doneFailed += plan.rowSlots.filter((s) => Boolean(s.error)).length
    }
    await report()
    // Durable live progress — the poll endpoint reads this row when the
    // in-memory registry has no entry (different process, or post-restart).
    await prisma.stockImportJob
      .update({
        where: { id: jobId },
        data: { processedRows, succeeded: doneSucceeded, failed: doneFailed, skipped: skippedCount, progressAt: new Date() },
      })
      .catch(() => {})
  }
  if (cancelled) {
    // Committed chunks stay committed; unwritten rows are closed honestly.
    for (const plan of planList) {
      if (writtenPlans.has(plan)) continue
      failedProducts.add(plan.productId)
      for (const slot of plan.rowSlots) {
        if (!slot.error) {
          slot.error = 'Cancelled before write'
          slot.warehouseApplied = false
          slot.channelApplied = false
        }
      }
    }
  }

  // ── After: BullMQ enqueue (bounded + circuit-broken adds; DB rows stay
  // PENDING for the drain cron when Redis is down — work is never lost) ──────
  const enqueueable = planList
    .filter((p) => !failedProducts.has(p.productId))
    .flatMap((p) => p.queueRows)
  const ENQUEUE_BATCH = 25
  for (let i = 0; i < enqueueable.length; i += ENQUEUE_BATCH) {
    await Promise.all(
      enqueueable.slice(i, i + ENQUEUE_BATCH).map((q) =>
        q.kind === 'IMPORT'
          ? addJobSafely(
              outboundSyncQueue,
              'sync-job',
              { queueId: q.id, productId: q.productId, syncType: 'QUANTITY_UPDATE', source: 'STOCK_IMPORT' },
              { delay: IMPORT_HOLD_MS, jobId: q.id },
            )
          : addJobSafely(
              outboundSyncQueue,
              'sync-job',
              { queueId: q.id, productId: q.productId, syncType: 'QUANTITY_UPDATE', source: 'STOCK_MOVEMENT', reason: 'MANUAL_ADJUSTMENT' },
              { delay: CASCADE_HOLD_MS, jobId: q.id },
            ),
      ),
    )
  }

  // ── After: stockout transitions — once per product (initial → final
  // available); a momentary mid-file dip no longer opens a phantom stockout.
  for (const plan of planList) {
    if (failedProducts.has(plan.productId) || plan.movements.length === 0) continue
    try {
      await handleMovementStockoutTransition({
        productId: plan.productId,
        sku: plan.sku,
        locationId: location.id,
        prevAvailable: plan.baseQty - plan.reserved,
        nextAvailable: plan.finalQty - plan.reserved,
      })
    } catch (err) {
      logger.warn('stock-import: stockout hook failed', {
        productId: plan.productId,
        err: err instanceof Error ? err.message : String(err),
      })
    }
  }

  // ── After: read-cache refresh — once per product, bounded concurrency,
  // fire-and-forget (ES.4 parity: the reconcile cron heals any miss). ────────
  const refreshIds = planList
    .filter((p) => !failedProducts.has(p.productId) && p.movements.length > 0)
    .map((p) => p.productId)
  if (refreshIds.length > 0) {
    void (async () => {
      const pending = [...refreshIds]
      await Promise.all(
        Array.from({ length: Math.min(4, pending.length) }, async () => {
          for (let id = pending.shift(); id !== undefined; id = pending.shift()) {
            await productReadCacheService.refresh(id).catch((err) =>
              logger.warn('stock-import: read-cache refresh failed (reconcile cron will heal)', {
                productId: id,
                err: err instanceof Error ? err.message : String(err),
              }),
            )
          }
        }),
      )
    })()
  }

  // ── Finalize ────────────────────────────────────────────────────────────────
  let succeeded = 0
  let failed = 0
  let skipped = 0
  const results: ApplyResult['results'] = slots.map((s) => {
    const inputs = {
      quantity: s.row.quantity,
      ...(s.row.channel ? { channel: s.row.channel } : {}),
      ...(s.row.marketplace ? { marketplace: s.row.marketplace } : {}),
    }
    if (s.skipped) {
      skipped++
      return { sku: s.row.resolvedSku ?? '?', raw: s.row.raw, applied: false, error: s.error, ...inputs }
    }
    if (s.error) {
      failed++
      return {
        sku: s.row.resolvedSku as string,
        raw: s.row.raw,
        applied: false,
        warehouseApplied: s.warehouseApplied,
        channelApplied: s.channelApplied,
        error: s.error,
        ...inputs,
      }
    }
    succeeded++
    return {
      sku: s.row.resolvedSku as string,
      raw: s.row.raw,
      applied: true,
      warehouseApplied: s.warehouseApplied,
      channelApplied: s.channelApplied,
      ...inputs,
    }
  })

  // Close job
  await prisma.stockImportJob.update({
    where: { id: jobId },
    data: {
      succeeded,
      failed,
      skipped,
      status: cancelled ? 'CANCELLED' : failed === 0 ? 'APPLIED' : succeeded > 0 ? 'PARTIAL' : 'FAILED',
      appliedAt: new Date(),
      processedRows,
      progressAt: new Date(),
      ...(cancelled ? { errorSummary: 'Cancelled by operator — rows not yet written were left unapplied.' } : {}),
      results: results as any,
    },
  })

  return { jobId, succeeded, failed, skipped, total: rows.length, results }
}

/**
 * IM.3.2 — close any StockImportJob stuck in APPLYING (server restarted or
 * crashed mid-apply). Committed chunks are already durable; the row is
 * finalized as PARTIAL with an honest summary. Called at API boot and lazily
 * from the progress endpoint when it polls a stale APPLYING row.
 */
export async function recoverStuckImportJobs(staleMs = 5 * 60_000): Promise<number> {
  const cutoff = new Date(Date.now() - staleMs)
  const stuck = await prisma.stockImportJob.findMany({
    where: {
      status: 'APPLYING',
      OR: [
        { progressAt: { lt: cutoff } },
        { progressAt: null, createdAt: { lt: cutoff } },
      ],
    },
    select: { id: true },
  })
  let healed = 0
  for (const job of stuck) {
    const res = await prisma.stockImportJob.updateMany({
      where: { id: job.id, status: 'APPLYING' },
      data: {
        status: 'PARTIAL',
        errorSummary:
          'Interrupted — the server restarted mid-apply. Counts reflect rows recorded before the interruption.',
        appliedAt: new Date(),
      },
    })
    healed += res.count
  }
  if (healed > 0) logger.warn('stock-import: healed stuck APPLYING jobs', { healed })
  return healed
}

// ── Batch revert (IM.3.4) ────────────────────────────────────────────────────

export class RevertNotAllowedError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'RevertNotAllowedError'
  }
}

export interface RevertResult {
  revertJobId: string
  warehouse: { products: number; succeeded: number; failed: number }
  channel: { restored: number; skippedNoPrior: number }
}

/**
 * IM.3.4 — one-click revert of an applied import.
 *
 * Warehouse side is EXACT: the net change per product is read back from the
 * movement ledger (referenceType=BulkImport, referenceId=jobId) and inverted
 * through the normal apply engine — full audit trail, cascade, outbound
 * sync, stockout + read-cache handling for free. The revert shows up in
 * history as its own job ("↩ revert of …").
 *
 * Channel side restores each explicitly-written listing from the import's
 * own queue-row payloads: `prior` (IM.3.4+ imports — exact, incl. pin
 * state) or `oldQuantity` (older imports). Listings without recorded
 * before-state are skipped and reported, never guessed.
 *
 * Guards: only finished jobs; at most once (atomic claim on
 * revertedByJobId); a product whose inverse would drive stock negative
 * fails its row through the engine's normal guard (honest partial revert).
 */
export async function revertImport(jobId: string, actor?: string | null): Promise<RevertResult> {
  const job = await prisma.stockImportJob.findUnique({ where: { id: jobId } })
  if (!job) throw new RevertNotAllowedError('Import not found')
  if (!['APPLIED', 'PARTIAL', 'CANCELLED'].includes(job.status)) {
    throw new RevertNotAllowedError('Only finished imports can be reverted')
  }

  // Atomic claim — two concurrent reverts can never both run.
  const claim = await prisma.stockImportJob.updateMany({
    where: { id: jobId, revertedByJobId: null },
    data: { revertedByJobId: 'PENDING' },
  })
  if (claim.count !== 1) throw new RevertNotAllowedError('This import was already reverted')

  try {
    // ── Warehouse: exact net per product from the ledger ──
    const movements = await prisma.stockMovement.findMany({
      where: { referenceType: 'BulkImport', referenceId: jobId },
      select: { productId: true, change: true },
    })
    const netByProduct = new Map<string, number>()
    for (const m of movements) {
      netByProduct.set(m.productId, (netByProduct.get(m.productId) ?? 0) + m.change)
    }
    for (const [pid, net] of [...netByProduct]) if (net === 0) netByProduct.delete(pid)

    const productMeta = netByProduct.size > 0
      ? await prisma.product.findMany({
          where: { id: { in: [...netByProduct.keys()] } },
          select: { id: true, sku: true, name: true },
        })
      : []
    const metaById = new Map(productMeta.map((p) => [p.id, p] as const))

    // ── Channel: explicit writes recorded by the import itself ──
    const queueRows = await prisma.outboundSyncQueue.findMany({
      where: { syncType: 'QUANTITY_UPDATE', payload: { path: ['referenceId'], equals: jobId } },
      select: {
        channelListingId: true, targetChannel: true, targetRegion: true,
        externalListingId: true, payload: true, productId: true,
      },
      orderBy: { createdAt: 'asc' },
    })
    interface ExplicitRestore {
      listingId: string
      prior: { quantity: number | null; quantityOverride: number | null; followMasterQuantity: boolean } | null
      oldQuantity: number | null
      channel: string
      region: string | null
      externalListingId: string | null
      productId: string | null
    }
    const explicitRestores = new Map<string, ExplicitRestore>()
    for (const q of queueRows) {
      const payload = q.payload as Record<string, unknown> | null
      // Cascade rows also carry referenceId — only explicit channel writes
      // (source STOCK_IMPORT) are restored; the warehouse inverse re-runs
      // the cascade for followed listings anyway.
      if (payload?.source !== 'STOCK_IMPORT' || !q.channelListingId) continue
      if (!explicitRestores.has(q.channelListingId)) {
        explicitRestores.set(q.channelListingId, {
          listingId: q.channelListingId,
          prior: (payload.prior as ExplicitRestore['prior']) ?? null,
          oldQuantity: (payload.oldQuantity as number | null) ?? null,
          channel: String(q.targetChannel),
          region: q.targetRegion,
          externalListingId: q.externalListingId,
          productId: q.productId,
        })
      }
    }

    if (netByProduct.size === 0 && explicitRestores.size === 0) {
      throw new RevertNotAllowedError('Nothing to revert — the import recorded no stock or listing changes')
    }

    const revertName = `↩ revert of ${job.filename ?? jobId.slice(-8)}`
    let revertJobId: string | null = null
    let warehouse = { products: 0, succeeded: 0, failed: 0 }

    if (netByProduct.size > 0) {
      const rows: PreviewRow[] = [...netByProduct].map(([productId, net]) => ({
        raw: metaById.get(productId)?.sku ?? productId,
        quantity: -net,
        productId,
        productName: metaById.get(productId)?.name ?? null,
        resolvedSku: metaById.get(productId)?.sku ?? '?',
        tier: 'EXACT' as const,
        candidates: [],
        currentWarehouseQty: null,
        wouldBeWarehouseQty: null,
        currentChannelQty: null,
        wouldBeChannelQty: null,
        channelListings: [],
        warnings: [],
        error: null,
        notes: `[REVERT ${jobId}]`,
      }))
      const res = await applyImport({
        rows,
        locationCode: job.locationCode,
        mode: 'ADJUST',
        target: 'WAREHOUSE',
        filename: revertName,
        actor,
      })
      revertJobId = res.jobId
      warehouse = { products: rows.length, succeeded: res.succeeded, failed: res.failed }
    }

    // ── Channel restore writes ──
    let restored = 0
    let skippedNoPrior = 0
    if (explicitRestores.size > 0) {
      if (!revertJobId) {
        const rj = await prisma.stockImportJob.create({
          data: {
            filename: revertName,
            locationCode: job.locationCode,
            mode: 'ADJUST',
            target: 'CHANNEL',
            totalRows: 0,
            status: 'APPLYING',
            startedAt: new Date(),
            progressAt: new Date(),
            ...(actor ? { createdBy: actor } : {}),
          },
          select: { id: true },
        })
        revertJobId = rj.id
      }
      const holdUntil = new Date(Date.now() + IMPORT_HOLD_MS)
      const restoreResults: ApplyResult['results'] = []
      const restoreQueue: Array<{ id: string; productId: string | null }> = []
      for (const r of explicitRestores.values()) {
        const targetQty = r.prior ? r.prior.quantity : r.oldQuantity
        if (targetQty == null) {
          skippedNoPrior++
          restoreResults.push({ sku: r.externalListingId ?? r.listingId, raw: `listing:${r.channel}`, applied: false, error: 'No before-state recorded (pre-IM.3.4 import) — restore manually' })
          continue
        }
        const qid = randomUUID()
        try {
          await prisma.$transaction(async (tx) => {
            await coalescePendingQuantityRows(tx, [r.listingId])
            await tx.channelListing.update({
              where: { id: r.listingId },
              data: {
                quantity: targetQty,
                lastSyncStatus: 'PENDING',
                lastSyncedAt: null,
                version: { increment: 1 },
                ...(r.prior
                  ? { quantityOverride: r.prior.quantityOverride, followMasterQuantity: r.prior.followMasterQuantity }
                  : {}),
              },
            })
            await tx.outboundSyncQueue.create({
              data: {
                id: qid,
                productId: r.productId,
                channelListingId: r.listingId,
                targetChannel: r.channel as any,
                targetRegion: r.region,
                syncStatus: 'PENDING' as any,
                syncType: 'QUANTITY_UPDATE',
                holdUntil,
                externalListingId: r.externalListingId,
                maxRetries: 3,
                payload: {
                  source: 'STOCK_IMPORT',
                  productId: r.productId,
                  channel: r.channel,
                  quantity: targetQty,
                  reason: 'MANUAL_ADJUSTMENT',
                  referenceType: 'BulkImportRevert',
                  referenceId: revertJobId,
                },
              },
            })
          })
          restoreQueue.push({ id: qid, productId: r.productId })
          restored++
          restoreResults.push({ sku: r.externalListingId ?? r.listingId, raw: `listing:${r.channel}`, applied: true, channelApplied: true, quantity: targetQty })
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err)
          restoreResults.push({ sku: r.externalListingId ?? r.listingId, raw: `listing:${r.channel}`, applied: false, error: msg })
        }
      }
      for (const q of restoreQueue) {
        await addJobSafely(
          outboundSyncQueue,
          'sync-job',
          { queueId: q.id, productId: q.productId ?? undefined, syncType: 'QUANTITY_UPDATE', source: 'STOCK_IMPORT' },
          { delay: IMPORT_HOLD_MS, jobId: q.id },
        )
      }
      // Fold channel outcomes into the revert job row honestly.
      const existing = await prisma.stockImportJob.findUnique({
        where: { id: revertJobId },
        select: { results: true, succeeded: true, failed: true, skipped: true, totalRows: true, processedRows: true },
      })
      const channelFailed = restoreResults.filter((r) => !r.applied && !/No before-state/.test(r.error ?? '')).length
      const succeededAll = (existing?.succeeded ?? 0) + restored
      const failedAll = (existing?.failed ?? 0) + channelFailed
      await prisma.stockImportJob.update({
        where: { id: revertJobId },
        data: {
          results: ([...((existing?.results as ApplyResult['results']) ?? []), ...restoreResults]) as any,
          succeeded: succeededAll,
          failed: failedAll,
          skipped: (existing?.skipped ?? 0) + skippedNoPrior,
          totalRows: (existing?.totalRows ?? 0) + restoreResults.length,
          processedRows: (existing?.processedRows ?? 0) + restoreResults.length,
          status: failedAll === 0 ? 'APPLIED' : succeededAll > 0 ? 'PARTIAL' : 'FAILED',
          appliedAt: new Date(),
          progressAt: new Date(),
        },
      })
    }

    await prisma.stockImportJob.update({
      where: { id: jobId },
      data: { revertedByJobId: revertJobId! },
    })
    return { revertJobId: revertJobId!, warehouse, channel: { restored, skippedNoPrior } }
  } catch (err) {
    // Release the claim so a failed revert attempt can be retried.
    await prisma.stockImportJob
      .updateMany({ where: { id: jobId, revertedByJobId: 'PENDING' }, data: { revertedByJobId: null } })
      .catch(() => {})
    throw err
  }
}

// ── Alias CRUD ────────────────────────────────────────────────────────────────

export async function bulkCreateAliases(
  entries: Array<{ productId: string; raw: string; source?: string }>,
): Promise<number> {
  let created = 0
  for (const e of entries) {
    const alias = normalizeAlias(e.raw)
    if (!alias) continue
    try {
      await prisma.skuAlias.upsert({
        where: { alias },
        create: { alias, raw: e.raw, productId: e.productId, source: e.source ?? 'IMPORT' },
        update: { productId: e.productId, source: e.source ?? 'IMPORT' },
      })
      created++
    } catch {
      // skip duplicates silently
    }
  }
  // New aliases must be visible to the next resolve/preview immediately.
  if (created > 0) invalidateResolutionIndex()
  return created
}
