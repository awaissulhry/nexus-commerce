import { variationBag } from './pim/shared-variation-values.js'
import prisma from '../db.js'
import { getInventoryFnskus, isFbaInboundConfigured } from './fba-inbound.service.js'
import { amazonAccountIdFor, amazonSkusInMarket } from './listings/reported-sku.js'

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

// Extract color/size/gender from a child Product. R-23 (Step 2.6c): the one store
// (`categoryAttributes.variations`) first; a legacy `variantAttributes` key only for an axis it lacks.
function extractAttrs(p: { variantAttributes: unknown; categoryAttributes: unknown }): Record<string, string> {
  return variationBag(p) as Record<string, string>
}

export async function lookupFnskus(skus: string[], marketplace = 'IT'): Promise<FnskuLookupResult[]> {
  if (skus.length === 0) return []

  // Variants are stored as child Product rows (parentId IS NOT NULL).
  // channelListings is filtered to the requested Amazon marketplace so the
  // label carries the *destination* marketplace's listing title (Amazon FBA
  // requires this to match exactly per shipment).
  const mp = marketplace.trim().toUpperCase() || 'IT'
  const products = await prisma.product.findMany({
    where: { sku: { in: skus } },
    select: {
      id: true,
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
        where: { channel: 'AMAZON', marketplace: mp },
        select: { title: true },
        take: 1,
      },
    },
  })

  type Row = typeof products[number]
  const productMap = new Map<string, Row>(products.map(p => [p.sku, p]))

  // S7 — the seller SKU Amazon knows each product by in this market (its main listing's own SKU; no listing there → the
  // product SKU, as before). `Product.fnsku` caches the FNSKU of the PRODUCT SKU: a product sold here under its own SKU
  // is read live for that SKU and never written into (or read from) that cache. No single SKU: an error, never a guess.
  const amazonSkus = await amazonSkusInMarket(prisma, { accountId: await amazonAccountIdFor(), marketplace: mp, products })
  const sellerSkuOf = new Map<string, string>()
  const skuError = new Map<string, string>()
  for (const p of products) {
    const amazon = amazonSkus.get(p.id)
    if (amazon && amazon.ok === false && amazon.code === 'CONFLICT') {
      skuError.set(p.sku, amazon.sentence)
      ;(p as any).fnsku = null
    } else if (amazon && amazon.ok === true && amazon.own) {
      sellerSkuOf.set(p.sku, amazon.sku)
      ;(p as any).fnsku = null
    }
  }

  // Collect SKUs that are in our DB but missing a cached FNSKU
  const uncached = skus.filter(sku => {
    const p = productMap.get(sku)
    return p && !p.fnsku && !skuError.has(sku)
  })

  let spApiError: string | undefined

  if (uncached.length > 0) {
    if (!(await isFbaInboundConfigured())) {
      spApiError = 'Amazon SP-API not configured — enter FNSKUs manually'
    } else {
      try {
        // Use FBA Inventory API — no ship-from address required, reads what
        // Amazon already has enrolled in FBA for these SKUs.
        const fetchedFnskus = await getInventoryFnskus(uncached.map(sku => sellerSkuOf.get(sku) ?? sku))

        const updates = uncached.flatMap(sku => {
          const fnsku = fetchedFnskus[sellerSkuOf.get(sku) ?? sku]
          return fnsku ? [[sku, fnsku] as const] : []
        })
        if (updates.length > 0) {
          await Promise.all(
            updates
              .filter(([sku]) => !sellerSkuOf.has(sku))
              .map(([sku, fnsku]) =>
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
    const unclear = skuError.get(sku)
    return {
      sku,
      fnsku: p.fnsku ?? null,
      asin: p.amazonAsin ?? null,
      ...(unclear ? { error: unclear } : needsFetch && spApiError && !spApiError.includes('not enrolled') ? { error: spApiError } : {}),
      productName: p.parent?.name ?? p.name ?? null,
      listingTitle: p.channelListings[0]?.title ?? p.name ?? null,
      variationAttributes: extractAttrs(p),
      imageUrl,
    }
  })
}
