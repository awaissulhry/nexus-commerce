/**
 * IE.4 — Refresh "what's currently live on Amazon" for a product.
 *
 * Fetches via SP-API GetListingsItem with includedData=['summaries',
 * 'images'], one call per (sellerSku, marketplace). Persists the
 * resulting image variants in ChannelLiveImage as a read-replica of
 * channel state — diffed against ListingImage in IE.5.
 *
 * Refresh shape:
 *   1. Resolve sellerId (env) + marketplaceId (from 2-letter code).
 *   2. Resolve sellerSku — for now this is `Product.sku` (parent) or
 *      every child's `sku` (variation). Future: read from
 *      ChannelListing once that table reliably stores Amazon SKUs.
 *   3. For each sku, GetListingsItem → unpack images → upsert one
 *      ChannelLiveImage per slot.
 *   4. Delete prior rows for this (product, marketplace, sku) that
 *      no longer appear in the fresh response — so a deleted image
 *      on Amazon's side shows as gone in Nexus too.
 *
 * Refresh is idempotent + fail-soft per SKU: one SKU's API failure
 * doesn't abort the whole product. Each result is reported back in
 * the response payload so the operator can see which calls failed.
 */

import prisma from '../../db.js'
import {
  amazonSpApiClient,
  type SpApiImageVariant,
} from '../../clients/amazon-sp-api.client.js'
import { marketplaceCodeToId } from '../../utils/marketplace-code.js'
import { createHash } from 'crypto'

export interface RefreshAmazonLiveImagesResult {
  productId: string
  marketplace: string
  skusAttempted: number
  skusOk: number
  skusFailed: number
  rowsUpserted: number
  rowsDeleted: number
  errors: Array<{ sku: string; message: string }>
}

interface RefreshOptions {
  productId: string
  marketplaceCode: string // 'IT' | 'DE' | 'FR' | 'ES' | 'UK'
  /** Optional explicit SKU list. When omitted we walk the product +
   *  its children and use their `.sku` fields. */
  skus?: string[]
}

function hashImages(images: SpApiImageVariant[]): string {
  // Stable hash of (variant + link) tuples in canonical order so the
  // next-refresh path can short-circuit if Amazon's response is
  // unchanged. Sorts by variant to absorb any reordering they might
  // do — the slot identity is what matters, not array position.
  const canon = images
    .map((i) => `${i.variant ?? ''}|${i.link}`)
    .sort()
    .join('\n')
  return createHash('sha256').update(canon).digest('hex')
}

export async function refreshAmazonLiveImages(
  opts: RefreshOptions,
): Promise<RefreshAmazonLiveImagesResult> {
  const { productId, marketplaceCode } = opts
  const errors: Array<{ sku: string; message: string }> = []
  let skusOk = 0
  let skusFailed = 0
  let rowsUpserted = 0
  let rowsDeleted = 0

  const sellerId =
    process.env.AMAZON_SELLER_ID ?? process.env.AMAZON_MERCHANT_ID ?? ''
  if (!sellerId) {
    throw new Error('AMAZON_SELLER_ID not configured')
  }
  const marketplaceId = marketplaceCodeToId(marketplaceCode)
  if (!marketplaceId) {
    throw new Error(`Unknown marketplace code: ${marketplaceCode}`)
  }

  const product = await prisma.product.findUnique({
    where: { id: productId },
    select: { id: true, sku: true, isParent: true },
  })
  if (!product) {
    throw new Error(`Product not found: ${productId}`)
  }

  // SKU list — operator override > children of parent > own SKU.
  // We try every relevant SKU because Amazon stores images per child
  // ASIN on variation listings; the parent SKU often returns no images
  // (parent is structural, not buyable).
  let skus: string[]
  if (opts.skus && opts.skus.length > 0) {
    skus = opts.skus
  } else if (product.isParent) {
    const children = await prisma.product.findMany({
      where: { parentId: product.id },
      select: { sku: true },
    })
    skus = children.map((c) => c.sku)
    // Include parent SKU too — it sometimes has the canonical MAIN
    // image even on variation listings.
    skus.push(product.sku)
  } else {
    skus = [product.sku]
  }

  for (const sku of skus) {
    let res
    try {
      res = await amazonSpApiClient.getListingsItem({
        sellerId,
        sku,
        marketplaceId,
        includedData: ['summaries', 'images'],
      })
    } catch (err) {
      skusFailed++
      errors.push({ sku, message: err instanceof Error ? err.message : String(err) })
      continue
    }
    if (!res.success) {
      skusFailed++
      errors.push({ sku, message: res.error ?? 'unknown SP-API error' })
      continue
    }
    skusOk++

    const images = res.images ?? []
    const etag = hashImages(images)

    // Upsert one row per slot/link pair. The unique index includes
    // slot so identical variants on different ASINs don't collide.
    const fetchedAt = new Date()
    const upserts: Promise<unknown>[] = []
    for (let i = 0; i < images.length; i++) {
      const img = images[i]
      upserts.push(
        prisma.channelLiveImage.upsert({
          where: {
            productId_channel_marketplace_externalSku_slot: {
              productId,
              channel: 'AMAZON',
              marketplace: marketplaceCode,
              externalSku: sku,
              slot: img.variant ?? `IDX_${i}`,
            },
          },
          create: {
            productId,
            channel: 'AMAZON',
            marketplace: marketplaceCode,
            externalSku: sku,
            asin: res.asin,
            slot: img.variant ?? `IDX_${i}`,
            url: img.link,
            width: img.width ?? null,
            height: img.height ?? null,
            sortOrder: i,
            etag,
            fetchedAt,
          },
          update: {
            asin: res.asin,
            url: img.link,
            width: img.width ?? null,
            height: img.height ?? null,
            sortOrder: i,
            etag,
            fetchedAt,
          },
        }),
      )
    }
    await Promise.all(upserts)
    rowsUpserted += images.length

    // Sweep stale rows — anything still tagged with the prior
    // fetchedAt for this (product, marketplace, sku) didn't make it
    // into the fresh response, so it's no longer live. Use the
    // fetchedAt cursor we just wrote as the "kept after" mark.
    const stale = await prisma.channelLiveImage.deleteMany({
      where: {
        productId,
        channel: 'AMAZON',
        marketplace: marketplaceCode,
        externalSku: sku,
        fetchedAt: { lt: fetchedAt },
      },
    })
    rowsDeleted += stale.count
  }

  return {
    productId,
    marketplace: marketplaceCode,
    skusAttempted: skus.length,
    skusOk,
    skusFailed,
    rowsUpserted,
    rowsDeleted,
    errors,
  }
}
