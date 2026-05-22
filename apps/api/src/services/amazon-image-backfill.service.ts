/**
 * IB.1 — backfill Product.images[] from Amazon's getCatalogItem.
 *
 * Walks every Product that has at least one Amazon ChannelListing with
 * a non-empty externalListingId (ASIN), calls SP-API getCatalogItem
 * (v2022-04-01) with includedData=['images'], parses the image array,
 * and upserts ProductImage rows.
 *
 * Per-product cost: ~1-2s SP-API latency. For 255 products = ~8-10 min
 * total wall-clock, fits inside Railway gateway only if chunked. To
 * avoid the gateway-timeout problem we saw on other backfills, this
 * orchestrator supports `limit` so the operator can call repeatedly
 * with small batches (e.g. 30 at a time).
 *
 * Idempotent: dedup on (productId, url) — re-running upserts on the
 * existing row, doesn't create duplicates.
 *
 * Pan-EU FBA assumption: Amazon shares listing images across all EU
 * marketplaces, so a single getCatalogItem call (default: IT) is
 * sufficient. Per-marketplace divergence handling deferred to IB.3.
 */

import prisma from '../db.js'
import { logger } from '../utils/logger.js'
import { AmazonService, AMAZON_MARKETPLACE_CODE_TO_ID } from './marketplaces/amazon.service.js'
const amazonService = new AmazonService()

export interface ImageBackfillResult {
  ranAt: string
  durationMs: number
  marketplaceId: string
  productsScanned: number
  productsWithImagesFetched: number
  imagesCreated: number
  imagesUpdated: number
  productsAccessDenied: number
  productsNoImages: number
  productsFailed: number
  errors: string[]
}

interface AmazonImage {
  link?: string
  url?: string
  variant?: string
  height?: number
  width?: number
}

interface AmazonImageGroup {
  marketplaceId?: string
  images?: AmazonImage[]
}

function inferType(variant?: string, index = 0): 'MAIN' | 'ALT' | 'LIFESTYLE' {
  if (index === 0) return 'MAIN'
  const v = (variant ?? '').toUpperCase()
  if (v === 'MAIN') return 'MAIN'
  if (v === 'PT01' || v === 'PT02' || v === 'PT03' || v === 'PT04' ||
      v === 'PT05' || v === 'PT06' || v === 'PT07' || v === 'PT08' ||
      v === 'PT09' || v === 'PT10' || v === 'PT11' || v === 'PT12' ||
      v === 'PT13' || v === 'PT14') {
    // Amazon PTxx variants are 'lifestyle' shots in their image-naming convention
    return 'LIFESTYLE'
  }
  return 'ALT'
}

export async function backfillProductImagesFromCatalog(opts: {
  /** Cap number of products processed in one call. Use to chunk
   *  through the catalog in batches that fit Railway's gateway. */
  limit?: number
  /** Skip products that already have at least one ProductImage row.
   *  Default true — set false to force re-fetch. */
  skipProductsWithImages?: boolean
  /** SP-API marketplace to fetch from. Default IT. */
  marketplaceId?: string
} = {}): Promise<ImageBackfillResult> {
  const t0 = Date.now()
  const limit = opts.limit ?? 50
  const skipProductsWithImages = opts.skipProductsWithImages !== false
  const marketplaceId = opts.marketplaceId
    ?? process.env.AMAZON_MARKETPLACE_ID
    ?? 'APJ6JRA9NG5V4'

  const errors: string[] = []
  let productsScanned = 0
  let productsWithImagesFetched = 0
  let imagesCreated = 0
  let imagesUpdated = 0
  let productsAccessDenied = 0
  let productsNoImages = 0
  let productsFailed = 0

  // IB.1.1 fix — pick (product, marketplace, asin) tuples, not just
  // (product, asin). Some products are listed only on DE/FR with
  // marketplace-specific ASINs that DON'T exist in the IT catalog;
  // querying IT for them returns "not found in marketplace". We now
  // query whatever marketplace the ChannelListing is actually scoped
  // to. The query orders IT first so the cheapest happy-path
  // (Pan-EU shared images, one fetch) wins when a product has
  // multiple marketplace listings — subsequent rows for the same
  // productId become no-ops via the per-(productId, url) dedup in the
  // upsert below.
  const productsRaw = await prisma.$queryRawUnsafe<
    Array<{ id: string; sku: string; asin: string; marketplace: string }>
  >(
    `SELECT p.id, p.sku,
            cl."externalListingId" AS asin,
            cl.marketplace AS marketplace
     FROM "Product" p
     JOIN "ChannelListing" cl ON cl."productId" = p.id
     WHERE p."deletedAt" IS NULL
       AND cl.channel = 'AMAZON'
       AND cl."externalListingId" IS NOT NULL
       AND cl."externalListingId" != ''
       ${skipProductsWithImages
         ? `AND NOT EXISTS (SELECT 1 FROM "ProductImage" pi WHERE pi."productId" = p.id)`
         : ''}
     ORDER BY p.sku ASC,
              CASE cl.marketplace WHEN 'IT' THEN 0 ELSE 1 END,
              cl.marketplace ASC
     LIMIT ${limit}`,
  )

  const sp = await (amazonService as unknown as { getClient: () => Promise<{ callAPI: (args: unknown) => Promise<unknown> }> }).getClient()

  // Track which (productId, marketplace) tuples we've fetched so
  // repeated rows for the same product (Pan-EU listings) become no-op
  // dedup at the outer scan. After IT lands images, FR/ES rows for the
  // same product are skipped since the ProductImage entries already
  // exist (the per-url upsert below catches it too, but skipping
  // saves the SP-API roundtrip).
  const fetchedProductIds = new Set<string>()

  for (const product of productsRaw) {
    productsScanned++
    if (fetchedProductIds.has(product.id)) {
      // already covered by an earlier marketplace's fetch this run
      continue
    }
    // IB.1.1: pick the per-row marketplaceId so DE/FR-only listings
    // get queried in their own marketplace, not always IT.
    const rowMarketplaceId =
      AMAZON_MARKETPLACE_CODE_TO_ID[product.marketplace] ?? marketplaceId
    try {
      const res = (await sp.callAPI({
        operation: 'getCatalogItem',
        endpoint: 'catalogItems',
        version: '2022-04-01',
        path: { asin: product.asin },
        query: {
          marketplaceIds: [rowMarketplaceId],
          includedData: ['images'],
        },
      })) as { images?: AmazonImageGroup[] }
      fetchedProductIds.add(product.id)

      // Amazon returns images grouped by marketplaceId; we asked for
      // one marketplace so there should be one group max.
      const imageGroup = Array.isArray(res?.images) ? res.images[0] : undefined
      const imgList = imageGroup?.images ?? []
      if (imgList.length === 0) {
        productsNoImages++
        continue
      }

      productsWithImagesFetched++

      for (let idx = 0; idx < imgList.length; idx++) {
        const img = imgList[idx]!
        const url = img.link ?? img.url ?? ''
        if (!url) continue
        const type = inferType(img.variant, idx)
        const alt = img.variant ?? null

        // Idempotent upsert: find by (productId, url), update existing
        // or create new. We can't use a Prisma upsert directly because
        // there's no composite unique on (productId, url).
        const existing = await prisma.productImage.findFirst({
          where: { productId: product.id, url },
          select: { id: true },
        })
        if (existing) {
          await prisma.productImage.update({
            where: { id: existing.id },
            data: {
              alt,
              type,
              sortOrder: idx,
              width: img.width ?? null,
              height: img.height ?? null,
            },
          })
          imagesUpdated++
        } else {
          await prisma.productImage.create({
            data: {
              productId: product.id,
              url,
              alt,
              type,
              sortOrder: idx,
              width: img.width ?? null,
              height: img.height ?? null,
            },
          })
          imagesCreated++
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      const isAccessDenied =
        msg.includes('Access denied') ||
        msg.includes('403') ||
        msg.includes('Forbidden')
      if (isAccessDenied) {
        productsAccessDenied++
      } else {
        productsFailed++
        if (errors.length < 20) {
          errors.push(`${product.sku} (${product.asin}): ${msg.slice(0, 200)}`)
        }
      }
      logger.warn('amazon-image-backfill: product failed', {
        sku: product.sku, asin: product.asin, error: msg.slice(0, 200),
      })
    }

    // SP-API getCatalogItem is 2 req/s sustained, burst 20. 250ms
    // between calls keeps us comfortably under.
    await new Promise((r) => setTimeout(r, 250))
  }

  const durationMs = Date.now() - t0
  logger.info('[amazon-image-backfill] complete', {
    productsScanned, productsWithImagesFetched, imagesCreated, imagesUpdated,
    productsAccessDenied, productsNoImages, productsFailed,
    errorCount: errors.length, durationMs,
  })

  return {
    ranAt: new Date().toISOString(),
    durationMs,
    marketplaceId,
    productsScanned,
    productsWithImagesFetched,
    imagesCreated,
    imagesUpdated,
    productsAccessDenied,
    productsNoImages,
    productsFailed,
    errors,
  }
}
