import prisma from '../db.js'
import { getInventoryFnskus, isFbaInboundConfigured } from './fba-inbound.service.js'

export interface FnskuLookupResult {
  sku: string
  fnsku: string | null
  asin: string | null
  error?: string
  productName: string | null
  listingTitle: string | null
  variationAttributes: Record<string, string>
  imageUrl: string | null
}

// Extract color/size/gender from child Product — try variantAttributes first,
// fall back to categoryAttributes.variations (both shapes are used in prod data).
function extractAttrs(p: { variantAttributes: unknown; categoryAttributes: unknown }): Record<string, string> {
  if (p.variantAttributes && typeof p.variantAttributes === 'object' && !Array.isArray(p.variantAttributes)) {
    return p.variantAttributes as Record<string, string>
  }
  const cat = p.categoryAttributes as any
  if (cat?.variations && typeof cat.variations === 'object') {
    return cat.variations as Record<string, string>
  }
  return {}
}

export async function lookupFnskus(skus: string[]): Promise<FnskuLookupResult[]> {
  if (skus.length === 0) return []

  // Variants are stored as child Product rows (parentId IS NOT NULL)
  const products = await prisma.product.findMany({
    where: { sku: { in: skus } },
    select: {
      sku: true,
      fnsku: true,
      amazonAsin: true,
      name: true,
      variantAttributes: true,
      categoryAttributes: true,
      images: { select: { url: true }, orderBy: { sortOrder: 'asc' }, take: 1 },
      parent: {
        select: {
          name: true,
          images: { select: { url: true }, orderBy: { sortOrder: 'asc' }, take: 1 },
        },
      },
      channelListings: {
        where: { channel: 'AMAZON', marketplace: 'IT' },
        select: { title: true },
        take: 1,
      },
    },
  })

  type Row = typeof products[number]
  const productMap = new Map<string, Row>(products.map(p => [p.sku, p]))

  // Collect SKUs that are in our DB but missing a cached FNSKU
  const uncached = skus.filter(sku => {
    const p = productMap.get(sku)
    return p && !p.fnsku
  })

  let spApiError: string | undefined

  if (uncached.length > 0) {
    if (!isFbaInboundConfigured()) {
      spApiError = 'Amazon SP-API not configured — enter FNSKUs manually'
    } else {
      try {
        // Use FBA Inventory API — no ship-from address required, reads what
        // Amazon already has enrolled in FBA for these SKUs.
        const fetchedFnskus = await getInventoryFnskus(uncached)

        const updates = Object.entries(fetchedFnskus)
        if (updates.length > 0) {
          await Promise.all(
            updates.map(([sku, fnsku]) =>
              prisma.product.updateMany({ where: { sku }, data: { fnsku } }),
            ),
          )
          for (const [sku, fnsku] of updates) {
            const p = productMap.get(sku)
            if (p) (p as any).fnsku = fnsku
          }
        }
      } catch (err: any) {
        spApiError = err?.message ?? 'Amazon SP-API request failed'
      }
    }
  }

  return skus.map(sku => {
    const p = productMap.get(sku)
    if (!p) {
      return {
        sku,
        fnsku: null,
        asin: null,
        error: 'SKU not found in database',
        productName: null,
        listingTitle: null,
        variationAttributes: {},
        imageUrl: null,
      }
    }
    const needsFetch = !p.fnsku
    const imageUrl = p.images[0]?.url ?? p.parent?.images[0]?.url ?? null
    return {
      sku,
      fnsku: p.fnsku ?? null,
      asin: p.amazonAsin ?? null,
      ...(needsFetch && spApiError && !spApiError.includes('not enrolled') ? { error: spApiError } : {}),
      productName: p.parent?.name ?? p.name ?? null,
      listingTitle: p.channelListings[0]?.title ?? p.name ?? null,
      variationAttributes: extractAttrs(p),
      imageUrl,
    }
  })
}
