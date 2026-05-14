/**
 * IM.9 — Shopify image publish service.
 *
 * Two operations in sequence:
 *
 * 1. Pool images → Shopify product images
 *    PUT /admin/api/{v}/products/{id}.json with { images: [{ src }] }
 *    This replaces the product's image set with our pool (source of truth).
 *    Shopify returns the images with their IDs; we match by array index
 *    (pool order = Shopify position order).
 *
 * 2. Variant image assignment
 *    For each colour group that has an assignment, find all variants with
 *    that colour, look up the Shopify image ID for the assigned URL by
 *    position index, then PUT each Shopify variant with image_id.
 *
 * Falls back gracefully when shopifyProductId or shopifyVariantId is missing.
 */

import prisma from '../../db.js'
import { ShopifyService } from '../marketplaces/shopify.service.js'
import { logger } from '../../utils/logger.js'

export interface ShopifyPublishResult {
  success: boolean
  message: string
  poolImagesPublished: number
  variantsAssigned: number
  error?: string
}

export async function publishShopifyImages(
  productId: string,
  activeAxis?: string,
): Promise<ShopifyPublishResult> {
  const product = await prisma.product.findUnique({
    where: { id: productId },
    select: { id: true, sku: true, shopifyProductId: true, imageAxisPreference: true },
  })
  if (!product) throw new Error(`Product ${productId} not found`)
  if (!product.shopifyProductId) {
    return { success: false, message: 'No Shopify product ID on this product', poolImagesPublished: 0, variantsAssigned: 0, error: 'Missing shopifyProductId' }
  }

  const axis = activeAxis ?? product.imageAxisPreference ?? 'Color'
  const shopifyProductId = product.shopifyProductId

  // Load pool images (platform=SHOPIFY, no variantGroup), ordered by position
  const poolImages = await prisma.listingImage.findMany({
    where: { productId, platform: 'SHOPIFY', variantGroupKey: null, variationId: null },
    orderBy: { position: 'asc' },
    select: { id: true, url: true, position: true },
  })

  // Load variant assignments (platform=SHOPIFY, variantGroupKey=axis)
  const assignments = await prisma.listingImage.findMany({
    where: { productId, platform: 'SHOPIFY', variantGroupKey: axis },
    select: { id: true, url: true, variantGroupValue: true },
  })

  // Load variants with Shopify IDs and their axis attribute values
  const variants = await prisma.productVariation.findMany({
    where: { productId },
    select: { id: true, shopifyVariantId: true, variationAttributes: true },
  })

  if (poolImages.length === 0) {
    return { success: false, message: 'No Shopify pool images to publish', poolImagesPublished: 0, variantsAssigned: 0, error: 'Pool is empty' }
  }

  // Validate credentials by instantiating the service — it throws if env vars missing
  try {
    new ShopifyService()
  } catch (err) {
    return {
      success: false,
      message: 'Shopify not configured (SHOPIFY_SHOP_NAME / SHOPIFY_ACCESS_TOKEN missing)',
      poolImagesPublished: 0,
      variantsAssigned: 0,
      error: err instanceof Error ? err.message : String(err),
    }
  }

  // ── Step 1: Replace product images ──────────────────────────────────
  let shopifyImages: Array<{ id: number; src: string; position: number }> = []
  // Use fetch directly — ShopifyService's makeRequestPublic is GET-only.
  // Same credentials pattern as the service itself.
  const shopNameGlobal = process.env.SHOPIFY_SHOP_NAME ?? ''
  const tokenGlobal = process.env.SHOPIFY_ACCESS_TOKEN ?? ''

  try {
    const putBody = {
      product: {
        id: shopifyProductId,
        images: poolImages.map((img) => ({ src: img.url })),
      },
    }

    const shopName = shopNameGlobal
    const token = tokenGlobal
    const apiVersion = '2024-01'

    const res = await fetch(
      `https://${shopName}.myshopify.com/admin/api/${apiVersion}/products/${shopifyProductId}.json`,
      {
        method: 'PUT',
        headers: {
          'X-Shopify-Access-Token': token,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(putBody),
      },
    )
    if (!res.ok) {
      const text = await res.text()
      throw new Error(`Shopify PUT products HTTP ${res.status}: ${text.slice(0, 200)}`)
    }
    const data = await res.json() as { product: { images: Array<{ id: number; src: string; position: number }> } }
    shopifyImages = data.product.images ?? []
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    await prisma.listingImage.updateMany({
      where: { productId, platform: 'SHOPIFY' },
      data: { publishStatus: 'ERROR', publishError: message },
    })
    return { success: false, message, poolImagesPublished: 0, variantsAssigned: 0, error: message }
  }

  // Mark pool images as published
  await prisma.listingImage.updateMany({
    where: { productId, platform: 'SHOPIFY', variantGroupKey: null },
    data: { publishStatus: 'PUBLISHED', publishedAt: new Date(), publishError: null },
  })

  // ── Step 2: Assign variant images ──────────────────────────────────
  // Map: pool image position (0-based) → Shopify image ID
  // Shopify returns images sorted by position (1-based); shopifyImages[i].position = i+1
  const positionToShopifyId = new Map<number, number>()
  shopifyImages.forEach((img, idx) => positionToShopifyId.set(idx, img.id))

  // Map: our pool URL → Shopify image ID (by index match)
  const urlToShopifyId = new Map<string, number>()
  poolImages.forEach((img, idx) => {
    const sid = positionToShopifyId.get(idx)
    if (sid) urlToShopifyId.set(img.url, sid)
  })

  const shopName = shopNameGlobal
  const token = tokenGlobal
  const apiVersion = '2024-01'

  let variantsAssigned = 0
  const assignedIds: string[] = []

  for (const assignment of assignments) {
    const shopifyImageId = urlToShopifyId.get(assignment.url)
    if (!shopifyImageId) continue  // assigned URL not in pool — skip

    const colorValue = assignment.variantGroupValue
    // Find all variants with this colour value
    const matchingVariants = variants.filter((v) => {
      const attrs = v.variationAttributes as Record<string, string> | null
      return attrs && attrs[axis] === colorValue
    })

    for (const variant of matchingVariants) {
      if (!variant.shopifyVariantId) continue
      try {
        const res = await fetch(
          `https://${shopName}.myshopify.com/admin/api/${apiVersion}/variants/${variant.shopifyVariantId}.json`,
          {
            method: 'PUT',
            headers: {
              'X-Shopify-Access-Token': token,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({ variant: { id: variant.shopifyVariantId, image_id: shopifyImageId } }),
          },
        )
        if (res.ok) variantsAssigned++
      } catch (err) {
        logger.warn('[shopify-image-publish] variant assign failed', { variantId: variant.shopifyVariantId, err })
      }
    }
    assignedIds.push(assignment.id)
  }

  // Mark assignment images as published
  if (assignedIds.length > 0) {
    await prisma.listingImage.updateMany({
      where: { id: { in: assignedIds } },
      data: { publishStatus: 'PUBLISHED', publishedAt: new Date(), publishError: null },
    })
  }

  logger.info('[shopify-image-publish] published', { productId, poolCount: poolImages.length, variantsAssigned })
  return {
    success: true,
    message: `Published ${poolImages.length} pool image${poolImages.length === 1 ? '' : 's'} and assigned ${variantsAssigned} variant${variantsAssigned === 1 ? '' : 's'} on Shopify`,
    poolImagesPublished: poolImages.length,
    variantsAssigned,
  }
}
