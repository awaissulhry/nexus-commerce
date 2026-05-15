import prisma from '../db.js'
import { createInboundShipmentPlan } from './fba-inbound.service.js'

export interface FnskuLookupResult {
  sku: string
  fnsku: string | null
  productName: string | null
  listingTitle: string | null
  variationAttributes: Record<string, string>
  imageUrl: string | null
}

export async function lookupFnskus(skus: string[]): Promise<FnskuLookupResult[]> {
  if (skus.length === 0) return []

  const variants = await prisma.productVariation.findMany({
    where: { sku: { in: skus } },
    select: {
      sku: true,
      fnsku: true,
      variationAttributes: true,
      product: {
        select: {
          name: true,
          images: { select: { url: true }, orderBy: { sortOrder: 'asc' }, take: 1 },
          channelListings: {
            where: { channel: 'AMAZON' },
            select: { title: true },
            take: 1,
          },
        },
      },
    },
  })

  type Variant = typeof variants[number]
  const variantMap = new Map<string, Variant>(variants.map(v => [v.sku, v]))

  // Collect SKUs that are missing cached FNSKU
  const uncached = skus.filter(sku => {
    const v = variantMap.get(sku)
    return v && !v.fnsku
  })

  if (uncached.length > 0) {
    try {
      const planResult = await createInboundShipmentPlan({
        items: uncached.map(sku => ({ sellerSku: sku, quantity: 1 })),
        labelPrepPreference: 'SELLER_LABEL',
      })

      const fetchedFnskus: Record<string, string> = {}
      for (const plan of planResult.shipmentPlans) {
        for (const item of plan.Items ?? []) {
          if (item.FulfillmentNetworkSKU) {
            fetchedFnskus[item.SellerSKU] = item.FulfillmentNetworkSKU
          }
        }
      }

      const updates = Object.entries(fetchedFnskus)
      if (updates.length > 0) {
        await Promise.all(
          updates.map(([sku, fnsku]) =>
            prisma.productVariation.updateMany({ where: { sku }, data: { fnsku } }),
          ),
        )
        for (const [sku, fnsku] of updates) {
          const v = variantMap.get(sku)
          if (v) (v as any).fnsku = fnsku
        }
      }
    } catch {
      // SP-API unavailable — return null FNSKUs, user can enter manually
    }
  }

  return skus.map(sku => {
    const v = variantMap.get(sku)
    if (!v) {
      return { sku, fnsku: null, productName: null, listingTitle: null, variationAttributes: {}, imageUrl: null }
    }
    const attrs = (v.variationAttributes ?? {}) as Record<string, string>
    return {
      sku,
      fnsku: v.fnsku ?? null,
      productName: v.product.name ?? null,
      listingTitle: v.product.channelListings[0]?.title ?? null,
      variationAttributes: attrs,
      imageUrl: v.product.images[0]?.url ?? null,
    }
  })
}
