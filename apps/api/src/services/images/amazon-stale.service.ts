/**
 * IA.5 — Detect ListingImage rows that are stale on the channel.
 *
 * "Stale" means: a row was successfully published in the past
 * (publishStatus='PUBLISHED'), and the master ProductImage it
 * references via sourceProductImageId has been updated SINCE that
 * publish (master.updatedAt > listingImage.publishedAt). Nexus is
 * showing the new URL via IE.6's effective-URL resolver, but Amazon
 * still has the previous bytes.
 *
 * Surfaced as a banner above the Amazon matrix so the operator can
 * one-click re-publish just the stale ASINs instead of resubmitting
 * the whole feed. Returns the variantId list so the FE can pass it
 * straight into the publisher's `variantIds` filter.
 */

import prisma from '../../db.js'

export interface StaleListingImagesResult {
  productId: string
  marketplace: string
  totalStaleRows: number
  /** Distinct ASINs that have at least one stale row at this marketplace. */
  staleAsins: string[]
  /** Distinct child Product / ProductVariation ids — feed straight to
   *  the publish endpoint's `variantIds` so re-publish targets only
   *  what needs updating. */
  staleVariantIds: string[]
}

export async function findStaleListingImages(input: {
  productId: string
  marketplace: string
}): Promise<StaleListingImagesResult> {
  const { productId } = input
  const marketplace = input.marketplace.toUpperCase()

  // Pull every published Amazon row for this product+marketplace
  // that links to a master. We do the staleness comparison in JS so
  // the query plan stays simple; the row count per product is small.
  const rows = await prisma.listingImage.findMany({
    where: {
      productId,
      platform: 'AMAZON',
      publishStatus: 'PUBLISHED',
      sourceProductImageId: { not: null },
      // MARKETPLACE-scoped rows must match the requested market;
      // PLATFORM-scoped rows apply to every marketplace so they're
      // included for any market.
      OR: [
        { scope: 'MARKETPLACE', marketplace },
        { scope: 'PLATFORM' },
      ],
    },
    select: {
      id: true,
      variationId: true,
      sourceProductImageId: true,
      publishedAt: true,
    },
  })

  if (rows.length === 0) {
    return { productId, marketplace, totalStaleRows: 0, staleAsins: [], staleVariantIds: [] }
  }

  // Batch-load the masters in one query — N+1 query stays cheap.
  const masterIds = Array.from(new Set(
    rows.map((r) => r.sourceProductImageId).filter((v): v is string => !!v),
  ))
  const masters = await prisma.productImage.findMany({
    where: { id: { in: masterIds } },
    select: { id: true, updatedAt: true },
  })
  const masterUpdatedAt = new Map(masters.map((m) => [m.id, m.updatedAt]))

  const staleVariantIds = new Set<string>()
  let staleCount = 0
  for (const row of rows) {
    if (!row.publishedAt || !row.sourceProductImageId) continue
    const mu = masterUpdatedAt.get(row.sourceProductImageId)
    if (!mu) continue
    if (mu.getTime() > row.publishedAt.getTime()) {
      staleCount++
      if (row.variationId) staleVariantIds.add(row.variationId)
    }
  }

  // Resolve variantIds → ASINs in one query. Try child Products first
  // (canonical PIM model), fall back to ProductVariation rows so the
  // legacy import path still surfaces.
  const variantIdList = Array.from(staleVariantIds)
  const [children, pvs] = await Promise.all([
    prisma.product.findMany({
      where: { id: { in: variantIdList } },
      select: { id: true, amazonAsin: true },
    }),
    prisma.productVariation.findMany({
      where: { id: { in: variantIdList } },
      select: { id: true, amazonAsin: true },
    }),
  ])
  const asinById = new Map<string, string | null>()
  for (const c of children) asinById.set(c.id, c.amazonAsin)
  for (const v of pvs) if (!asinById.has(v.id)) asinById.set(v.id, v.amazonAsin)

  const staleAsins = Array.from(new Set(
    variantIdList
      .map((id) => asinById.get(id))
      .filter((v): v is string => !!v),
  ))

  return {
    productId,
    marketplace,
    totalStaleRows: staleCount,
    staleAsins,
    staleVariantIds: variantIdList,
  }
}
