import prisma from '../db.js'
import { createInboundShipmentPlan, isFbaInboundConfigured } from './fba-inbound.service.js'

export interface FnskuLookupResult {
  sku: string
  fnsku: string | null
  error?: string
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

  // Collect SKUs that are in our DB but missing a cached FNSKU
  const uncached = skus.filter(sku => {
    const v = variantMap.get(sku)
    return v && !v.fnsku
  })

  let spApiError: string | undefined

  if (uncached.length > 0) {
    if (!isFbaInboundConfigured()) {
      spApiError = 'Amazon SP-API not configured — enter FNSKUs manually'
    } else {
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
      } catch (err: any) {
        spApiError = err?.message ?? 'Amazon SP-API request failed'
      }
    }
  }

  return skus.map(sku => {
    const v = variantMap.get(sku)
    // SKU not in our DB at all — return as a stub so user can enter FNSKU manually
    if (!v) {
      return {
        sku,
        fnsku: null,
        error: 'SKU not found in database',
        productName: null,
        listingTitle: null,
        variationAttributes: {},
        imageUrl: null,
      }
    }
    const attrs = (v.variationAttributes ?? {}) as Record<string, string>
    const needsFetch = !v.fnsku
    return {
      sku,
      fnsku: v.fnsku ?? null,
      // Only attach spApiError for SKUs that actually needed a fetch attempt
      ...(needsFetch && spApiError ? { error: spApiError } : {}),
      productName: v.product.name ?? null,
      listingTitle: v.product.channelListings[0]?.title ?? null,
      variationAttributes: attrs,
      imageUrl: v.product.images[0]?.url ?? null,
    }
  })
}
