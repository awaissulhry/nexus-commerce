/**
 * PB.8b — Refresh "what's currently live on Shopify" for a product.
 *
 * Calls Shopify REST API GET /admin/api/2024-01/products/{id}.json,
 * parses the `images` array + each variant's `image_id`, upserts
 * the result into ChannelLiveImage as a read-replica of channel state.
 *
 * Two row shapes per product:
 *   - Pool images: externalSku=null, slot = position-as-string ('1'..'N').
 *     These show in the LiveChannelStrip's main row.
 *   - Variant image assignments: externalSku=variant.sku, slot=variant.id
 *     (string), url = the assigned image's src. These let the FE
 *     diff per-variant assignments against ListingImage rows.
 *
 * Dev-mode safety:
 *   Returns skipped='NO_CREDS' when SHOPIFY_SHOP_NAME or
 *   SHOPIFY_ACCESS_TOKEN is missing, skipped='NO_PRODUCT_ID' when the
 *   product has no shopifyProductId. UI surfaces these so the operator
 *   sees the right hint instead of a 500.
 */

import prisma from '../../db.js'

export interface RefreshShopifyLiveImagesResult {
  productId: string
  channel: 'SHOPIFY'
  shopifyProductId: string | null
  poolImagesFetched: number
  variantsWithImage: number
  rowsUpserted: number
  rowsDeleted: number
  skipped?: 'NO_PRODUCT_ID' | 'NO_CREDS'
  error?: string
}

interface RefreshOptions {
  productId: string
}

interface ShopifyImageNode {
  id: number
  product_id: number
  position: number
  src: string
  width?: number | null
  height?: number | null
}

interface ShopifyVariantNode {
  id: number
  sku: string | null
  image_id: number | null
  title?: string | null
}

interface ShopifyProductResponse {
  product: {
    id: number
    title: string
    images: ShopifyImageNode[]
    variants: ShopifyVariantNode[]
  }
}

function hasCreds(): boolean {
  return !!(process.env.SHOPIFY_SHOP_NAME && process.env.SHOPIFY_ACCESS_TOKEN)
}

export async function refreshShopifyLiveImages(
  opts: RefreshOptions,
): Promise<RefreshShopifyLiveImagesResult> {
  const { productId } = opts

  const base: Omit<RefreshShopifyLiveImagesResult, 'shopifyProductId'> = {
    productId,
    channel: 'SHOPIFY',
    poolImagesFetched: 0,
    variantsWithImage: 0,
    rowsUpserted: 0,
    rowsDeleted: 0,
  }

  const product = await prisma.product.findUnique({
    where: { id: productId },
    select: { id: true, shopifyProductId: true },
  })
  if (!product?.shopifyProductId) {
    return { ...base, shopifyProductId: null, skipped: 'NO_PRODUCT_ID' }
  }
  if (!hasCreds()) {
    return { ...base, shopifyProductId: product.shopifyProductId, skipped: 'NO_CREDS' }
  }

  const shopName = process.env.SHOPIFY_SHOP_NAME!
  const token = process.env.SHOPIFY_ACCESS_TOKEN!
  const apiVersion = '2024-01'
  const url = `https://${shopName}.myshopify.com/admin/api/${apiVersion}/products/${product.shopifyProductId}.json`

  let data: ShopifyProductResponse
  try {
    const res = await fetch(url, {
      method: 'GET',
      headers: { 'X-Shopify-Access-Token': token, 'Content-Type': 'application/json' },
    })
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      return {
        ...base,
        shopifyProductId: product.shopifyProductId,
        error: `Shopify GET products HTTP ${res.status}: ${text.slice(0, 200)}`,
      }
    }
    data = await res.json() as ShopifyProductResponse
  } catch (err) {
    return {
      ...base,
      shopifyProductId: product.shopifyProductId,
      error: err instanceof Error ? err.message : 'GET products failed',
    }
  }

  const images = data.product?.images ?? []
  const variants = data.product?.variants ?? []
  const imageById = new Map<number, ShopifyImageNode>()
  for (const i of images) imageById.set(i.id, i)

  const seenKeys = new Set<string>()
  let upserted = 0
  let variantsWithImage = 0

  // Pool images. slot = position (1-based, as Shopify returns it).
  for (const img of images) {
    const slot = String(img.position)
    seenKeys.add(`null|${slot}`)
    await prisma.channelLiveImage.upsert({
      where: {
        productId_channel_marketplace_externalSku_slot: {
          productId,
          channel: 'SHOPIFY',
          marketplace: null,
          externalSku: null,
          slot,
        } as any,
      },
      create: {
        productId,
        channel: 'SHOPIFY',
        marketplace: null,
        externalSku: null,
        asin: null,
        slot,
        url: img.src,
        width: img.width ?? null,
        height: img.height ?? null,
        sortOrder: img.position,
      },
      update: {
        url: img.src,
        width: img.width ?? null,
        height: img.height ?? null,
        sortOrder: img.position,
        fetchedAt: new Date(),
      },
    })
    upserted++
  }

  // Variant-image assignments. externalSku = variant.sku (when set);
  // slot = variant.id; url = the resolved image's src.
  for (const v of variants) {
    if (!v.image_id) continue
    const img = imageById.get(v.image_id)
    if (!img) continue
    const externalSku = v.sku ?? `variant-${v.id}`
    const slot = String(v.id)
    seenKeys.add(`${externalSku}|${slot}`)
    await prisma.channelLiveImage.upsert({
      where: {
        productId_channel_marketplace_externalSku_slot: {
          productId,
          channel: 'SHOPIFY',
          marketplace: null,
          externalSku,
          slot,
        } as any,
      },
      create: {
        productId,
        channel: 'SHOPIFY',
        marketplace: null,
        externalSku,
        asin: null,
        slot,
        url: img.src,
        width: img.width ?? null,
        height: img.height ?? null,
        sortOrder: img.position,
      },
      update: {
        url: img.src,
        width: img.width ?? null,
        height: img.height ?? null,
        sortOrder: img.position,
        fetchedAt: new Date(),
      },
    })
    upserted++
    variantsWithImage++
  }

  // Delete stale rows for this (product, SHOPIFY).
  const existing = await prisma.channelLiveImage.findMany({
    where: { productId, channel: 'SHOPIFY' },
    select: { id: true, externalSku: true, slot: true },
  })
  const toDelete = existing
    .filter((r) => {
      const k = `${r.externalSku ?? 'null'}|${r.slot ?? ''}`
      return !seenKeys.has(k)
    })
    .map((r) => r.id)
  let deleted = 0
  if (toDelete.length > 0) {
    const res = await prisma.channelLiveImage.deleteMany({ where: { id: { in: toDelete } } })
    deleted = res.count
  }

  return {
    ...base,
    shopifyProductId: product.shopifyProductId,
    poolImagesFetched: images.length,
    variantsWithImage,
    rowsUpserted: upserted,
    rowsDeleted: deleted,
  }
}
