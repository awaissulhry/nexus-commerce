/**
 * Listing Reconciliation Service (Phase RECON)
 *
 * Pulls every active listing from a channel (Amazon IT by default, eBay soon),
 * matches each to a Nexus Product/Variation by SKU → ASIN → GTIN, and writes
 * results to ListingReconciliation. Operator reviews each row in the UI before
 * Nexus writes externalListingId back to ChannelListing.
 *
 * Matching priority:
 *   1. SKU exact match against ProductVariation.sku (confidence 1.0, method SKU)
 *   2. SKU exact match against Product.sku         (confidence 0.95, method PARENT_SKU)
 *   3. ASIN match against Product.amazonAsin        (confidence 0.85, method ASIN)
 *   4. ASIN match against ChannelListing.externalListingId (0.80, method ASIN)
 *   5. No match → UNMATCHED (confidence 0)
 *
 * Re-running is idempotent: upsert on (channel, marketplace, externalSku).
 * Previously CONFIRMED rows are never overwritten (preserves operator decisions).
 */

import prisma from '../db.js'
import { AmazonService } from './marketplaces/amazon.service.js'
import { logger } from '../utils/logger.js'

export type ReconChannel = 'AMAZON' | 'EBAY'
export type ReconStatus = 'PENDING' | 'CONFIRMED' | 'CONFLICT' | 'CREATE_NEW' | 'IGNORE'
export type MatchMethod = 'SKU' | 'PARENT_SKU' | 'ASIN' | 'GTIN' | 'MANUAL' | 'UNMATCHED'

export interface ReconRunSummary {
  runId: string
  channel: ReconChannel
  marketplace: string
  totalDiscovered: number
  matched: number
  unmatched: number
  skipped: number // rows that were already CONFIRMED — not re-evaluated
  durationMs: number
}

interface MatchResult {
  matchedProductId: string | null
  matchedVariationId: string | null
  matchMethod: MatchMethod
  matchConfidence: number
}

async function matchBySku(
  skus: string[]
): Promise<Map<string, { productId: string; variationId: string | null; isVariation: boolean }>> {
  const result = new Map<string, { productId: string; variationId: string | null; isVariation: boolean }>()

  if (skus.length === 0) return result

  const [variations, products] = await Promise.all([
    prisma.productVariation.findMany({
      where: { sku: { in: skus } },
      select: { id: true, sku: true, productId: true },
    }),
    prisma.product.findMany({
      where: { sku: { in: skus } },
      select: { id: true, sku: true },
    }),
  ])

  for (const v of variations) {
    result.set(v.sku, { productId: v.productId, variationId: v.id, isVariation: true })
  }
  // Product-level SKU only if no variation matched
  for (const p of products) {
    if (!result.has(p.sku)) {
      result.set(p.sku, { productId: p.id, variationId: null, isVariation: false })
    }
  }

  return result
}

async function matchByAsin(
  asins: string[]
): Promise<Map<string, string>> {
  // Returns asin → productId
  const result = new Map<string, string>()
  if (asins.length === 0) return result

  const [byProductField, byListing] = await Promise.all([
    prisma.product.findMany({
      where: { amazonAsin: { in: asins } },
      select: { id: true, amazonAsin: true },
    }),
    prisma.channelListing.findMany({
      where: {
        channel: 'AMAZON',
        externalListingId: { in: asins },
      },
      select: { productId: true, externalListingId: true },
    }),
  ])

  for (const p of byProductField) {
    if (p.amazonAsin) result.set(p.amazonAsin, p.id)
  }
  for (const cl of byListing) {
    if (cl.externalListingId && !result.has(cl.externalListingId)) {
      result.set(cl.externalListingId, cl.productId)
    }
  }

  return result
}

function resolveMatch(
  sku: string,
  asin: string | null,
  skuMap: Map<string, { productId: string; variationId: string | null; isVariation: boolean }>,
  asinMap: Map<string, string>
): MatchResult {
  const bySkuExact = skuMap.get(sku)
  if (bySkuExact) {
    return {
      matchedProductId: bySkuExact.productId,
      matchedVariationId: bySkuExact.variationId,
      matchMethod: bySkuExact.isVariation ? 'SKU' : 'PARENT_SKU',
      matchConfidence: bySkuExact.isVariation ? 1.0 : 0.95,
    }
  }

  if (asin) {
    const byAsin = asinMap.get(asin)
    if (byAsin) {
      return {
        matchedProductId: byAsin,
        matchedVariationId: null,
        matchMethod: 'ASIN',
        matchConfidence: 0.85,
      }
    }
  }

  return {
    matchedProductId: null,
    matchedVariationId: null,
    matchMethod: 'UNMATCHED',
    matchConfidence: 0,
  }
}

export async function runAmazonReconciliation(
  marketplace: string = 'IT'
): Promise<ReconRunSummary> {
  const t0 = Date.now()
  const runId = `AMAZON-${marketplace}-${Date.now()}`

  logger.info('[recon] Starting Amazon reconciliation', { marketplace, runId })

  const amazonService = new AmazonService()
  if (!amazonService.isConfigured()) {
    throw new Error('Amazon SP-API credentials not configured — check AMAZON_LWA_CLIENT_ID, AMAZON_LWA_CLIENT_SECRET, AMAZON_REFRESH_TOKEN')
  }

  // Pull the merchant listings report (~5 min for large catalogs, polls internally)
  const catalog = await amazonService.fetchActiveCatalog()
  logger.info('[recon] Catalog fetched', { count: catalog.length, marketplace, runId })

  if (catalog.length === 0) {
    return { runId, channel: 'AMAZON', marketplace, totalDiscovered: 0, matched: 0, unmatched: 0, skipped: 0, durationMs: Date.now() - t0 }
  }

  // Find rows already CONFIRMED — skip re-evaluation to preserve operator decisions
  const existingConfirmed = await prisma.listingReconciliation.findMany({
    where: { channel: 'AMAZON', marketplace, reconciliationStatus: 'CONFIRMED' },
    select: { externalSku: true },
  })
  const confirmedSkus = new Set(existingConfirmed.map(r => r.externalSku))

  const toProcess = catalog.filter(item => !confirmedSkus.has(item.sku))
  const skipped = catalog.length - toProcess.length

  // Bulk match lookups
  const skus = toProcess.map(item => item.sku)
  const asins = [...new Set(toProcess.map(item => item.asin).filter(Boolean) as string[])]

  const [skuMap, asinMap] = await Promise.all([
    matchBySku(skus),
    matchByAsin(asins),
  ])

  // Build upsert payloads
  let matched = 0
  let unmatched = 0

  const ops = toProcess.map(item => {
    const match = resolveMatch(item.sku, item.asin, skuMap, asinMap)
    if (match.matchedProductId) matched++; else unmatched++

    return prisma.listingReconciliation.upsert({
      where: {
        channel_marketplace_externalSku: {
          channel: 'AMAZON',
          marketplace,
          externalSku: item.sku,
        },
      },
      create: {
        channel: 'AMAZON',
        marketplace,
        externalSku: item.sku,
        externalListingId: item.asin || null,
        parentAsin: item.parentAsin || null,
        title: item.title || null,
        channelPrice: item.price ? item.price : null,
        channelQuantity: item.quantity ?? null,
        channelStatus: item.status || null,
        matchedProductId: match.matchedProductId,
        matchedVariationId: match.matchedVariationId,
        matchMethod: match.matchMethod,
        matchConfidence: match.matchConfidence,
        reconciliationStatus: 'PENDING',
        runId,
      },
      update: {
        // Refresh channel data + re-run match, but keep operator fields
        externalListingId: item.asin || null,
        parentAsin: item.parentAsin || null,
        title: item.title || null,
        channelPrice: item.price ? item.price : null,
        channelQuantity: item.quantity ?? null,
        channelStatus: item.status || null,
        matchedProductId: match.matchedProductId,
        matchedVariationId: match.matchedVariationId,
        matchMethod: match.matchMethod,
        matchConfidence: match.matchConfidence,
        runId,
        // Do NOT reset reconciliationStatus (preserve CONFLICT / IGNORE decisions)
      },
    })
  })

  // Execute in batches of 50 to avoid overwhelming the DB connection pool
  const BATCH = 50
  for (let i = 0; i < ops.length; i += BATCH) {
    await prisma.$transaction(ops.slice(i, i + BATCH))
  }

  const summary: ReconRunSummary = {
    runId,
    channel: 'AMAZON',
    marketplace,
    totalDiscovered: catalog.length,
    matched,
    unmatched,
    skipped,
    durationMs: Date.now() - t0,
  }

  logger.info('[recon] Amazon reconciliation complete', summary)
  return summary
}

/**
 * Confirm a reconciliation row: write externalListingId + ASIN to the
 * matching ChannelListing (upsert if not found), then mark row CONFIRMED.
 */
export async function confirmReconRow(id: string, reviewedBy: string): Promise<void> {
  const row = await prisma.listingReconciliation.findUniqueOrThrow({ where: { id } })

  if (!row.matchedProductId) {
    throw new Error('Cannot confirm an unmatched row — link to a product first')
  }
  if (!row.externalListingId) {
    throw new Error('Row has no externalListingId — channel data may be incomplete')
  }

  await prisma.$transaction(async (tx) => {
    // Upsert ChannelListing for this product+channel+marketplace
    const existing = await tx.channelListing.findFirst({
      where: {
        productId: row.matchedProductId!,
        channel: row.channel,
        marketplace: row.marketplace,
      },
      select: { id: true },
    })

    if (existing) {
      await tx.channelListing.update({
        where: { id: existing.id },
        data: {
          externalListingId: row.externalListingId,
          listingStatus: 'ACTIVE',
          price: row.channelPrice ?? undefined,
          masterQuantity: row.channelQuantity ?? undefined,
        },
      })
    } else {
      // Stub listing record so Nexus knows about it
      await tx.channelListing.create({
        data: {
          productId: row.matchedProductId!,
          channel: row.channel,
          marketplace: row.marketplace,
          channelMarket: `${row.channel}_${row.marketplace}`,
          region: row.marketplace,
          externalListingId: row.externalListingId,
          listingStatus: 'ACTIVE',
          title: row.title ?? undefined,
          price: row.channelPrice ?? undefined,
          masterQuantity: row.channelQuantity ?? undefined,
        },
      })
    }

    await tx.listingReconciliation.update({
      where: { id },
      data: {
        reconciliationStatus: 'CONFIRMED',
        reviewedBy,
        reviewedAt: new Date(),
        importedAt: new Date(),
      },
    })
  })
}

/**
 * Manually link a row to a specific product (overrides auto-match).
 */
export async function linkReconRow(
  id: string,
  productId: string,
  variationId: string | null,
  reviewedBy: string
): Promise<void> {
  // Verify the product exists
  await prisma.product.findUniqueOrThrow({ where: { id: productId } })

  await prisma.listingReconciliation.update({
    where: { id },
    data: {
      matchedProductId: productId,
      matchedVariationId: variationId,
      matchMethod: 'MANUAL',
      matchConfidence: 1.0,
      reconciliationStatus: 'PENDING', // awaits confirmation
      reviewedBy,
      reviewedAt: new Date(),
    },
  })
}

export async function setReconRowStatus(
  id: string,
  status: ReconStatus,
  reviewedBy: string,
  notes?: string
): Promise<void> {
  await prisma.listingReconciliation.update({
    where: { id },
    data: {
      reconciliationStatus: status,
      reviewedBy,
      reviewedAt: new Date(),
      conflictNotes: notes ?? undefined,
    },
  })
}

export interface ReconListOptions {
  channel?: string
  marketplace?: string
  status?: string
  runId?: string
  page?: number
  pageSize?: number
}

export async function listReconRows(opts: ReconListOptions = {}) {
  const { channel, marketplace, status, runId, page = 1, pageSize = 50 } = opts
  const where: Record<string, unknown> = {}
  if (channel) where.channel = channel
  if (marketplace) where.marketplace = marketplace
  if (status) where.reconciliationStatus = status
  if (runId) where.runId = runId

  const [rows, total] = await Promise.all([
    prisma.listingReconciliation.findMany({
      where,
      orderBy: [{ matchConfidence: 'desc' }, { createdAt: 'asc' }],
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
    prisma.listingReconciliation.count({ where }),
  ])

  // Attach product/variation names for UI display
  const productIds = [...new Set(rows.map(r => r.matchedProductId).filter(Boolean) as string[])]
  const products =
    productIds.length > 0
      ? await prisma.product.findMany({
          where: { id: { in: productIds } },
          select: { id: true, sku: true, name: true },
        })
      : []
  const productMap = new Map(products.map(p => [p.id, p]))

  return {
    rows: rows.map(r => ({
      ...r,
      matchedProduct: r.matchedProductId ? productMap.get(r.matchedProductId) ?? null : null,
    })),
    total,
    page,
    pageSize,
    totalPages: Math.ceil(total / pageSize),
  }
}

export async function getReconStats(channel: string, marketplace: string) {
  const stats = await prisma.listingReconciliation.groupBy({
    by: ['reconciliationStatus'],
    where: { channel, marketplace },
    _count: { _all: true },
  })

  const byStatus: Record<string, number> = {}
  for (const s of stats) {
    byStatus[s.reconciliationStatus] = s._count._all
  }

  const byMethod = await prisma.listingReconciliation.groupBy({
    by: ['matchMethod'],
    where: { channel, marketplace },
    _count: { _all: true },
  })

  const matchMethods: Record<string, number> = {}
  for (const m of byMethod) {
    if (m.matchMethod) matchMethods[m.matchMethod] = m._count._all
  }

  return { byStatus, matchMethods, total: Object.values(byStatus).reduce((a, b) => a + b, 0) }
}
