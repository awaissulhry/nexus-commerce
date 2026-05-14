/**
 * IM.9 — eBay image publish service.
 *
 * Reads ListingImage rows for the product (platform=EBAY), builds a
 * ReviseItem request with:
 *   PictureDetails               ← gallery images (no variantGroup), ordered
 *   Variations.VariationSpecificPictureSet ← per-colour images
 *
 * Calls eBay Trading API via eBayAPIProvider.reviseItemImages().
 * On success, marks all affected ListingImage rows as PUBLISHED.
 * On failure, marks them ERROR + stores the error message.
 *
 * Uses the product's imageAxisPreference as the colour axis name
 * (the VariationSpecificName in the XML). Falls back to "Color".
 */

import prisma from '../../db.js'
import { eBayAPIProvider } from '../../providers/ebay.provider.js'
import { logger } from '../../utils/logger.js'

export interface EbayPublishResult {
  success: boolean
  message: string
  pictureCount: number
  colorSetCount: number
  error?: string
}

export async function publishEbayImages(
  productId: string,
  activeAxis?: string,
): Promise<EbayPublishResult> {
  const product = await prisma.product.findUnique({
    where: { id: productId },
    select: { id: true, sku: true, ebayItemId: true, imageAxisPreference: true },
  })
  if (!product) throw new Error(`Product ${productId} not found`)
  if (!product.ebayItemId) {
    return { success: false, message: 'No eBay listing ID on this product', pictureCount: 0, colorSetCount: 0, error: 'Missing ebayItemId' }
  }

  const axis = activeAxis ?? product.imageAxisPreference ?? 'Color'

  // Load all eBay listing images in one query
  const allEbayImages = await prisma.listingImage.findMany({
    where: { productId, platform: 'EBAY' },
    orderBy: { position: 'asc' },
    select: {
      id: true, url: true, position: true,
      variantGroupKey: true, variantGroupValue: true,
    },
  })

  // Gallery images — product-level, no variantGroup
  const galleryImages = allEbayImages.filter((i) => !i.variantGroupKey)
  const galleryUrls = galleryImages.map((i) => i.url)

  // Colour sets — grouped by variantGroupValue
  const colorMap = new Map<string, string[]>()
  for (const img of allEbayImages.filter((i) => i.variantGroupKey === axis)) {
    const val = img.variantGroupValue ?? '—'
    if (!colorMap.has(val)) colorMap.set(val, [])
    colorMap.get(val)!.push(img.url)
  }
  const colorSets = Array.from(colorMap.entries()).map(([value, urls]) => ({
    axisName: axis,
    value,
    urls,
  }))

  if (galleryUrls.length === 0 && colorSets.length === 0) {
    return { success: false, message: 'No eBay images to publish', pictureCount: 0, colorSetCount: 0, error: 'No images assigned to eBay' }
  }

  const provider = new eBayAPIProvider()
  const result = await provider.reviseItemImages({
    itemId: product.ebayItemId,
    galleryUrls,
    colorSets,
  })

  const affectedIds = allEbayImages.map((i) => i.id)

  if (result.success) {
    await prisma.listingImage.updateMany({
      where: { id: { in: affectedIds } },
      data: { publishStatus: 'PUBLISHED', publishedAt: new Date(), publishError: null },
    })
    logger.info('[ebay-image-publish] published', { productId, pictureCount: galleryUrls.length, colorSetCount: colorSets.length })
    return {
      success: true,
      message: `Published ${galleryUrls.length} gallery image${galleryUrls.length === 1 ? '' : 's'} and ${colorSets.length} colour set${colorSets.length === 1 ? '' : 's'} to eBay`,
      pictureCount: galleryUrls.length,
      colorSetCount: colorSets.length,
    }
  } else {
    await prisma.listingImage.updateMany({
      where: { id: { in: affectedIds } },
      data: { publishStatus: 'ERROR', publishError: result.error ?? 'Unknown error' },
    })
    return {
      success: false,
      message: result.error ?? 'eBay publish failed',
      pictureCount: galleryUrls.length,
      colorSetCount: colorSets.length,
      error: result.error,
    }
  }
}
