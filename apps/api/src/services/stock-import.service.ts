/**
 * Stock Import Service — IM.1
 *
 * Resolution engine + import pipeline for the bulk inventory wizard.
 *
 * Resolution tiers (in order):
 *   1. Exact Product.sku match
 *   2. SkuAlias.alias match (operator-defined or import-confirmed)
 *   3. Fuzzy product.name match (case-insensitive contains)
 *   4. Barcode match (product.ean / product.upc)
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
import { logger } from '../utils/logger.js'

// ── Public types ─────────────────────────────────────────────────────────────

export type ResolutionTier = 'EXACT' | 'ALIAS' | 'FUZZY_NAME' | 'BARCODE' | 'UNRESOLVED'
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

export interface PreviewRow extends ResolvedRow {
  currentWarehouseQty: number | null
  wouldBeWarehouseQty: number | null
  currentChannelQty: number | null
  wouldBeChannelQty: number | null
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
}

export async function resolveRows(rows: ImportRow[]): Promise<ResolvedRow[]> {
  const raws = rows.map((r) => r.raw.trim()).filter(Boolean)
  if (raws.length === 0) return []

  // Load all products (small catalog, ~279 for Xavia — single query is fine)
  const products = await prisma.product.findMany({
    select: { id: true, sku: true, name: true, ean: true, upc: true },
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

    // Tier 3: fuzzy name (contains, case-insensitive)
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

    if (nameCandidates.length > 0) {
      const best = productById.get(nameCandidates[0].productId)!
      return {
        ...row,
        productId: best.id,
        productName: best.name,
        resolvedSku: best.sku,
        tier: 'FUZZY_NAME',
        candidates: nameCandidates,
      }
    }

    // Tier 4: barcode (EAN/UPC)
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

    // Unresolved
    return {
      ...row,
      productId: null,
      productName: null,
      resolvedSku: null,
      tier: 'UNRESOLVED',
      candidates: nameCandidates.slice(0, 5),
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

  // Batch-load channel listings for CHANNEL/BOTH targets
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

  const previewRows: PreviewRow[] = resolved.map((r): PreviewRow => {
    const warnings: string[] = []
    let error: string | null = null

    if (r.tier === 'UNRESOLVED') { unresolvedCount++; error = 'SKU not found — assign manually' }
    else if (r.tier === 'FUZZY_NAME') { fuzzyCount++ }
    else { resolvedCount++ }

    const sl = r.productId ? stockByProduct.get(r.productId) : undefined
    const currentWarehouseQty = sl?.quantity ?? (r.productId ? 0 : null)

    let wouldBeWarehouseQty: number | null = null
    if (currentWarehouseQty !== null && r.productId && target !== 'CHANNEL') {
      wouldBeWarehouseQty = mode === 'SET' ? r.quantity : currentWarehouseQty + r.quantity
      if (wouldBeWarehouseQty < 0) {
        error = `Would go negative (${currentWarehouseQty} + ${r.quantity} = ${wouldBeWarehouseQty})`
        errorCount++
      }
    }

    // Channel preview
    const cls = r.productId ? (channelListingsByProduct.get(r.productId) ?? []) : []
    const activeCls = cls.filter((cl) => cl.listingStatus !== 'ENDED')
    const currentChannelQty = activeCls.length > 0
      ? activeCls[0].quantityOverride ?? activeCls[0].quantity ?? null
      : null
    const wouldBeChannelQty = target !== 'WAREHOUSE' && currentChannelQty !== null
      ? (mode === 'SET' ? r.quantity : currentChannelQty + r.quantity)
      : null

    if (wouldBeChannelQty !== null && wouldBeChannelQty < 0) {
      warnings.push(`Channel qty would go negative (${currentChannelQty} → ${wouldBeChannelQty})`)
    }

    if (r.tier === 'FUZZY_NAME') warnings.push('Fuzzy match — please verify this is the correct product')
    if (!error && r.productId) wouldUpdateCount++

    return {
      ...r,
      currentWarehouseQty,
      wouldBeWarehouseQty,
      currentChannelQty,
      wouldBeChannelQty,
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

// ── Apply ─────────────────────────────────────────────────────────────────────

export async function applyImport(opts: {
  rows: PreviewRow[]
  locationCode: string
  mode: ImportMode
  target: ImportTarget
  filename?: string
  fileKind?: string
}): Promise<ApplyResult> {
  const { rows, locationCode, mode, target, filename, fileKind } = opts

  const location = await prisma.stockLocation.findUnique({
    where: { code: locationCode },
    select: { id: true, type: true },
  })
  if (!location) throw new Error(`Location ${locationCode} not found`)
  if (location.type === 'AMAZON_FBA') throw new Error('FBA locations are read-only')

  // Create audit job
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

  let succeeded = 0, failed = 0, skipped = 0
  const results: ApplyResult['results'] = []

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
          // Compute delta = target - current
          const sl = await prisma.stockLevel.findFirst({
            where: { locationId: location.id, productId: row.productId },
            select: { quantity: true },
          })
          const current = sl?.quantity ?? 0
          const delta = row.quantity - current
          if (delta !== 0) {
            await applyStockMovement({
              productId: row.productId,
              locationId: location.id,
              change: delta,
              reason: 'MANUAL_ADJUSTMENT',
              referenceType: 'BulkImport',
              referenceId: job.id,
              actor: 'bulk-import',
              notes: row.notes ?? `[SET ${row.quantity}] ${row.raw}`,
            })
          }
        } else {
          await applyStockMovement({
            productId: row.productId,
            locationId: location.id,
            change: row.quantity,
            reason: 'MANUAL_ADJUSTMENT',
            referenceType: 'BulkImport',
            referenceId: job.id,
            actor: 'bulk-import',
            notes: row.notes ?? `[ADJUST ${row.quantity > 0 ? '+' : ''}${row.quantity}] ${row.raw}`,
          })
        }
        warehouseApplied = true
      } catch (err) {
        rowError = err instanceof Error ? err.message : String(err)
        logger.error('stock-import: warehouse apply failed', { sku: row.resolvedSku, error: rowError })
      }
    }

    // ── Channel quantity override ──
    if (target !== 'WAREHOUSE' && !rowError) {
      try {
        const cls = await prisma.channelListing.findMany({
          where: {
            productId: row.productId,
            channel: row.channel ? { equals: row.channel } : { in: ['AMAZON', 'EBAY', 'SHOPIFY'] },
            ...(row.marketplace ? { marketplace: row.marketplace } : {}),
          },
          select: { id: true, quantityOverride: true, quantity: true },
        })

        const newQty = mode === 'SET'
          ? row.quantity
          : ((cls[0]?.quantityOverride ?? cls[0]?.quantity ?? 0) + row.quantity)

        for (const cl of cls) {
          await prisma.channelListing.update({
            where: { id: cl.id },
            data: {
              quantityOverride: Math.max(0, newQty),
              followMasterQuantity: false,
            },
          })
        }
        if (cls.length > 0) channelApplied = true
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

  // Close job
  await prisma.stockImportJob.update({
    where: { id: job.id },
    data: {
      succeeded,
      failed,
      skipped,
      status: failed === 0 ? 'APPLIED' : succeeded > 0 ? 'PARTIAL' : 'FAILED',
      appliedAt: new Date(),
      results: results as any,
    },
  })

  return { jobId: job.id, succeeded, failed, skipped, total: rows.length, results }
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
