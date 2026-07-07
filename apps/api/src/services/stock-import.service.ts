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

import prisma from '../db.js'
import { applyStockMovement } from './stock-movement.service.js'
import { coalescePendingQuantityRows } from './sync-coalesce.js'
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

export async function resolveRows(rows: ImportRow[]): Promise<ResolvedRow[]> {
  const raws = rows.map((r) => r.raw.trim()).filter(Boolean)
  if (raws.length === 0) return []

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
  let channelListingsByProduct = new Map<string, Array<{ id: string; channel: string; marketplace: string; quantity: number | null; quantityOverride: number | null; listingStatus: string }>>()
  if (target !== 'WAREHOUSE') {
    const cls = await prisma.channelListing.findMany({
      where: {
        productId: { in: productIds },
        channel: { in: ['AMAZON', 'EBAY', 'SHOPIFY'] },
      },
      select: { id: true, productId: true, channel: true, marketplace: true, quantity: true, quantityOverride: true, listingStatus: true },
    })
    for (const cl of cls) {
      const existing = channelListingsByProduct.get(cl.productId) ?? []
      existing.push(cl)
      channelListingsByProduct.set(cl.productId, existing)
    }
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

// ── Apply ─────────────────────────────────────────────────────────────────────

export async function applyImport(opts: {
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
}): Promise<ApplyResult> {
  const { rows, locationCode, mode, target, filename, fileKind, pinOverride = false } = opts

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
        status: 'PENDING',
      },
    })
    jobId = job.id
  }

  // IM.2 P4 — batched pre-reads. SET-mode warehouse bases and channel
  // listings load in two queries instead of two per row; duplicate-SKU rows
  // stay sequentially correct via in-memory effective state (same model the
  // preview uses).
  const applicable = rows.filter((r) => !r.error && r.productId && r.resolvedSku)
  const applicableProductIds = [...new Set(applicable.map((r) => r.productId as string))]
  const warehouseQtyByProduct = new Map<string, number>()
  if (target !== 'CHANNEL' && mode === 'SET' && applicableProductIds.length > 0) {
    const sls = await prisma.stockLevel.findMany({
      where: { locationId: location.id, productId: { in: applicableProductIds } },
      select: { productId: true, quantity: true },
    })
    for (const sl of sls) warehouseQtyByProduct.set(sl.productId, sl.quantity)
  }
  type ApplyListing = {
    id: string
    productId: string
    channel: string
    region: string
    marketplace: string
    quantity: number | null
    quantityOverride: number | null
    externalListingId: string | null
  }
  const listingsByProduct = new Map<string, ApplyListing[]>()
  const listingEffectiveQty = new Map<string, number>()
  if (target !== 'WAREHOUSE' && applicableProductIds.length > 0) {
    const cls = await prisma.channelListing.findMany({
      where: {
        productId: { in: applicableProductIds },
        listingStatus: { not: 'ENDED' },
        channel: { in: ['AMAZON', 'EBAY', 'SHOPIFY'] },
      },
      select: {
        id: true, productId: true, channel: true, region: true, marketplace: true,
        quantity: true, quantityOverride: true, externalListingId: true,
      },
    })
    for (const cl of cls) {
      const arr = listingsByProduct.get(cl.productId) ?? []
      arr.push(cl)
      listingsByProduct.set(cl.productId, arr)
    }
  }

  let succeeded = 0, failed = 0, skipped = 0
  const results: ApplyResult['results'] = []
  // BullMQ jobs are added AFTER each row's transaction commits (rows stay
  // PENDING for the cron drain if Redis is down — same as stock movements).
  const queuedJobIds: Array<{ queueId: string; productId: string }> = []

  for (const row of rows) {
    if (row.error || !row.productId || !row.resolvedSku) {
      skipped++
      results.push({ sku: row.resolvedSku ?? '?', raw: row.raw, applied: false, error: row.error ?? 'unresolved' })
      continue
    }

    let warehouseApplied = false
    let channelApplied = false
    let rowError: string | undefined

    // ── Warehouse ──
    if (target !== 'CHANNEL') {
      try {
        if (mode === 'SET') {
          // Delta vs the batched base, kept sequentially correct for
          // duplicate-SKU rows via the in-memory effective map.
          const current = warehouseQtyByProduct.get(row.productId) ?? 0
          const delta = row.quantity - current
          if (delta !== 0) {
            await applyStockMovement({
              productId: row.productId,
              locationId: location.id,
              change: delta,
              reason: 'MANUAL_ADJUSTMENT',
              referenceType: 'BulkImport',
              referenceId: jobId,
              actor: 'bulk-import',
              notes: row.notes ?? `[SET ${row.quantity}] ${row.raw}`,
            })
          }
          warehouseQtyByProduct.set(row.productId, row.quantity)
          warehouseApplied = true
        } else if (row.quantity !== 0) {
          await applyStockMovement({
            productId: row.productId,
            locationId: location.id,
            change: row.quantity,
            reason: 'MANUAL_ADJUSTMENT',
            referenceType: 'BulkImport',
            referenceId: jobId,
            actor: 'bulk-import',
            notes: row.notes ?? `[ADJUST ${row.quantity > 0 ? '+' : ''}${row.quantity}] ${row.raw}`,
          })
          warehouseApplied = true
        }
        // ADJUST of 0 is a valid no-op (applyStockMovement rejects change=0)
      } catch (err) {
        rowError = err instanceof Error ? err.message : String(err)
        logger.error('stock-import: warehouse apply failed', { sku: row.resolvedSku, error: rowError })
      }
    }

    // ── Channel listing quantity (IM.2 P3) ──
    // Per-listing arithmetic, ENDED listings skipped, quantity + sync-state
    // written and an OutboundSyncQueue row enqueued so the marketplace push
    // actually happens. followMasterQuantity flips ONLY behind pinOverride.
    if (target !== 'WAREHOUSE' && !rowError) {
      try {
        const cls = (listingsByProduct.get(row.productId) ?? [])
          .filter((cl) => !row.channel || cl.channel === row.channel)
          .filter((cl) => !row.marketplace || cl.marketplace === row.marketplace)

        if (cls.length === 0) {
          const filterDesc = [row.channel, row.marketplace].filter(Boolean).join('/')
          const msg = `No active channel listing matches${filterDesc ? ` (${filterDesc})` : ''}`
          if (target === 'CHANNEL') {
            rowError = msg
          }
          // BOTH: warehouse already applied — surfaced via channelApplied=false
        } else {
          const validTargets = new Set(['AMAZON', 'EBAY', 'SHOPIFY', 'WOOCOMMERCE'])
          const holdUntil = new Date(Date.now() + IMPORT_HOLD_MS)
          const createdQueueIds = await prisma.$transaction(async (tx) => {
            const ids: string[] = []
            // Cancel superseded PENDING quantity pushes for these listings —
            // only the freshest imported value should dispatch.
            await coalescePendingQuantityRows(tx, cls.map((c) => c.id))
            for (const cl of cls) {
              const current = listingEffectiveQty.get(cl.id) ?? cl.quantityOverride ?? cl.quantity ?? 0
              const newQty = Math.max(0, mode === 'SET' ? row.quantity : current + row.quantity)
              listingEffectiveQty.set(cl.id, newQty)
              await tx.channelListing.update({
                where: { id: cl.id },
                data: {
                  quantity: newQty,
                  lastSyncStatus: 'PENDING',
                  lastSyncedAt: null,
                  version: { increment: 1 },
                  ...(pinOverride ? { quantityOverride: newQty, followMasterQuantity: false } : {}),
                },
              })
              if (validTargets.has(cl.channel)) {
                const qRow = await tx.outboundSyncQueue.create({
                  data: {
                    productId: row.productId!,
                    channelListingId: cl.id,
                    targetChannel: cl.channel as any,
                    targetRegion: cl.region,
                    syncStatus: 'PENDING' as any,
                    syncType: 'QUANTITY_UPDATE',
                    holdUntil,
                    externalListingId: cl.externalListingId,
                    maxRetries: 3,
                    payload: {
                      source: 'STOCK_IMPORT',
                      productId: row.productId,
                      channel: cl.channel,
                      marketplace: cl.marketplace,
                      quantity: newQty,
                      oldQuantity: cl.quantity,
                      pinOverride,
                      reason: 'MANUAL_ADJUSTMENT',
                      referenceType: 'BulkImport',
                      referenceId: jobId,
                    },
                  },
                  select: { id: true },
                })
                ids.push(qRow.id)
              }
            }
            return ids
          })
          for (const queueId of createdQueueIds) {
            queuedJobIds.push({ queueId, productId: row.productId })
          }
          channelApplied = true
        }
      } catch (err) {
        rowError = err instanceof Error ? err.message : String(err)
        logger.error('stock-import: channel apply failed', { sku: row.resolvedSku, error: rowError })
      }
    }

    if (rowError) {
      failed++
      results.push({ sku: row.resolvedSku, raw: row.raw, applied: false, warehouseApplied, channelApplied, error: rowError })
    } else {
      succeeded++
      results.push({ sku: row.resolvedSku, raw: row.raw, applied: true, warehouseApplied, channelApplied })
    }
  }

  // BullMQ enqueue AFTER commits. addJobSafely is bounded + circuit-broken, so
  // an unreachable Redis can never hang the apply loop — the DB rows stay
  // PENDING and the drain cron picks them up (Redis-down degrades to cron).
  for (const { queueId, productId } of queuedJobIds) {
    await addJobSafely(
      outboundSyncQueue,
      'sync-job',
      { queueId, productId, syncType: 'QUANTITY_UPDATE', source: 'STOCK_IMPORT' },
      { delay: IMPORT_HOLD_MS, jobId: queueId },
    )
  }

  // Close job
  await prisma.stockImportJob.update({
    where: { id: jobId },
    data: {
      succeeded,
      failed,
      skipped,
      status: failed === 0 ? 'APPLIED' : succeeded > 0 ? 'PARTIAL' : 'FAILED',
      appliedAt: new Date(),
      results: results as any,
    },
  })

  return { jobId, succeeded, failed, skipped, total: rows.length, results }
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
  return created
}
