/**
 * G.1.3 — Pricing snapshot materialization.
 *
 * Walks the catalog, calls pricing-engine.resolvePrice() for every
 * (sku, channel, marketplace, fulfillment) tuple that has a
 * ChannelListing, and upserts the result into PricingSnapshot.
 *
 * Read paths (the matrix UI, /pricing/alerts, the outbound push) all
 * read from PricingSnapshot — never the engine directly. That makes
 * /pricing reads sub-50ms even at 32K cells.
 *
 * Refresh triggers:
 *   - On-demand: refreshSnapshotsForSkus([sku, ...]) after a price/cost/
 *     rule write
 *   - Nightly: refreshAllSnapshots() picks up FX-driven shifts
 *   - Hourly: same, when a scheduled promotion enters or exits a window
 */

import type { PrismaClient } from '@prisma/client'
import { resolvePrice } from './pricing-engine.service.js'
import { logger } from '../utils/logger.js'

interface RefreshResult {
  rowsRefreshed: number
  skusProcessed: number
  durationMs: number
}

/**
 * Refresh all (sku × channel × marketplace × fulfillment) snapshots for
 * the given SKU list. Use after a price/cost/rule write so the matrix
 * UI and outbound queue see the new value immediately.
 *
 * For each SKU, derives the (channel, marketplace) tuples from existing
 * ChannelListing rows on the SKU's parent Product. SKUs without any
 * ChannelListing yield no snapshots (the matrix UI won't show empty
 * cells; the SKU only appears once it has a listing).
 */
export async function refreshSnapshotsForSkus(
  prisma: PrismaClient,
  skus: string[],
): Promise<RefreshResult> {
  const startedAt = Date.now()
  if (skus.length === 0) {
    return { rowsRefreshed: 0, skusProcessed: 0, durationMs: 0 }
  }

  // Resolve every SKU to its parent Product so we can pull
  // ChannelListings. SKUs may be ProductVariation or standalone Product.
  const variants = await prisma.productVariation.findMany({
    where: { sku: { in: skus } },
    select: { sku: true, productId: true },
  })
  const standalone = await prisma.product.findMany({
    where: { sku: { in: skus } },
    select: { sku: true, id: true },
  })
  const productIdBySku = new Map<string, string>()
  for (const v of variants) productIdBySku.set(v.sku, v.productId)
  for (const p of standalone) productIdBySku.set(p.sku, p.id)

  const productIds = [...new Set([...productIdBySku.values()])]
  if (productIds.length === 0) {
    return {
      rowsRefreshed: 0,
      skusProcessed: 0,
      durationMs: Date.now() - startedAt,
    }
  }

  // ChannelListings define the (channel, marketplace) cells we need to
  // materialize for each SKU.
  const listings = await prisma.channelListing.findMany({
    where: { productId: { in: productIds } },
    select: { productId: true, channel: true, marketplace: true },
  })
  const listingsByProductId = new Map<string, Array<{ channel: string; marketplace: string }>>()
  for (const l of listings) {
    const arr = listingsByProductId.get(l.productId) ?? []
    arr.push({ channel: l.channel, marketplace: l.marketplace })
    listingsByProductId.set(l.productId, arr)
  }

  // Per-listing offers tell us which fulfillment-method-specific rows to
  // materialize. When an Offer exists for FBA and FBM, we write 3 rows
  // per listing: default (null fm), FBA, FBM. When no Offer override
  // exists, we write only the default row.
  const channelListingIds = (
    await prisma.channelListing.findMany({
      where: { productId: { in: productIds } },
      select: { id: true, productId: true, channel: true, marketplace: true },
    })
  )
  const offerKeys = await prisma.offer.findMany({
    where: { channelListingId: { in: channelListingIds.map((c) => c.id) } },
    select: { channelListingId: true, fulfillmentMethod: true },
  })
  const fmsByListing = new Map<string, Set<'FBA' | 'FBM'>>()
  for (const o of offerKeys) {
    const set = fmsByListing.get(o.channelListingId) ?? new Set<'FBA' | 'FBM'>()
    set.add(o.fulfillmentMethod as 'FBA' | 'FBM')
    fmsByListing.set(o.channelListingId, set)
  }
  const listingByKey = new Map<string, string>() // (productId|channel|marketplace) -> listingId
  for (const l of channelListingIds) {
    listingByKey.set(`${l.productId}|${l.channel}|${l.marketplace}`, l.id)
  }

  let rowsRefreshed = 0
  for (const sku of skus) {
    const productId = productIdBySku.get(sku)
    if (!productId) continue
    const cells = listingsByProductId.get(productId) ?? []
    for (const cell of cells) {
      // Always materialize the default-fulfillment row.
      const fmsToMaterialize: Array<'FBA' | 'FBM' | null> = [null]
      const listingId = listingByKey.get(
        `${productId}|${cell.channel}|${cell.marketplace}`,
      )
      const fmOverrides = listingId ? fmsByListing.get(listingId) : null
      if (fmOverrides) {
        for (const fm of fmOverrides) fmsToMaterialize.push(fm)
      }
      for (const fm of fmsToMaterialize) {
        const resolution = await resolvePrice(prisma, {
          sku,
          channel: cell.channel,
          marketplace: cell.marketplace,
          fulfillmentMethod: fm,
        })
        // Prisma's compound-unique can't accept null on `fulfillmentMethod`;
        // the SQL migration uses two partial unique indexes (one with the
        // column NOT NULL and one WHERE the column IS NULL). At the
        // application layer that means findFirst + create/update instead
        // of typed upsert.
        const data = {
          computedPrice: resolution.price.toFixed(2),
          currency: resolution.currency,
          source: resolution.source,
          breakdown: resolution.breakdown as any,
          isClamped: resolution.constraints.isClamped,
          clampedFrom: resolution.constraints.isClamped
            ? resolution.constraints.clampedFrom.toFixed(2)
            : null,
          warnings: resolution.warnings,
          computedAt: resolution.computedAt,
        }
        const existing = await prisma.pricingSnapshot.findFirst({
          where: {
            sku,
            channel: cell.channel,
            marketplace: cell.marketplace,
            fulfillmentMethod: fm,
          },
          select: { id: true },
        })
        if (existing) {
          await prisma.pricingSnapshot.update({
            where: { id: existing.id },
            data,
          })
        } else {
          await prisma.pricingSnapshot.create({
            data: {
              sku,
              channel: cell.channel,
              marketplace: cell.marketplace,
              fulfillmentMethod: fm,
              ...data,
            },
          })
        }
        rowsRefreshed++
      }
    }
  }

  const durationMs = Date.now() - startedAt
  logger.info('G.1.3 snapshot refresh complete', {
    skusProcessed: skus.length,
    rowsRefreshed,
    durationMs,
  })

  return {
    rowsRefreshed,
    skusProcessed: skus.length,
    durationMs,
  }
}

/**
 * Refresh every snapshot in the catalog. Used by the nightly cron and
 * by manual full-refresh endpoint. For Xavia's 3.2K SKUs × ~5 marketplaces
 * × ~1.2 fulfillment-methods average ≈ 19K snapshot rows; engine call
 * is ~5ms each, totals ~95s — acceptable for nightly batch.
 */
export async function refreshAllSnapshots(
  prisma: PrismaClient,
): Promise<RefreshResult> {
  const startedAt = Date.now()
  // Distinct SKUs across ProductVariation + standalone Product.
  const variants = await prisma.productVariation.findMany({
    select: { sku: true },
  })
  const products = await prisma.product.findMany({
    where: { variations: { none: {} } }, // standalone only
    select: { sku: true },
  })
  const allSkus = [...new Set([...variants.map((v) => v.sku), ...products.map((p) => p.sku)])]
  const result = await refreshSnapshotsForSkus(prisma, allSkus)
  return {
    ...result,
    durationMs: Date.now() - startedAt,
  }
}
