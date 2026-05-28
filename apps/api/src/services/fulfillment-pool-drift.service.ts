/**
 * FCF.6 — per-pool fulfillment drift.
 *
 * "Drift" here = the gap between what a channel listing currently PUBLISHES
 * (ChannelListing.quantity) and what its bound stock pool can actually back
 * (available-to-publish, after reservations + buffer). A positive drift means
 * the listing is OVERSOLD relative to its pool:
 *   • FBM listing publishing more than own-warehouse available, or
 *   • FBA/MCF listing publishing more than FBA SELLABLE minus in-flight MCF.
 *
 * This is distinct from ChannelStockEvent drift (channel-reported qty vs our
 * physical stock). This one is computed from our own pools, so it surfaces
 * oversell risk BEFORE the marketplace reports back.
 */

import prisma from '../db.js'
import { computeAvailableToPublish } from './available-to-publish.service.js'
import { MARKETPLACE_ID_TO_CODE } from '../utils/marketplace-code.js'
import { getPendingMcfReservedByProduct } from './amazon-mcf.service.js'

const MERCHANT_CHANNELS = new Set(['EBAY', 'SHOPIFY', 'WOOCOMMERCE', 'ETSY'])
const ACTIVE_STATUSES = ['ACTIVE', 'BUYABLE']
const DEFAULT_LIMIT = 2000

export type PoolDriftRow = {
  productId: string
  sku: string
  name: string | null
  channel: string
  marketplace: string
  fulfillmentMethod: 'FBA' | 'FBM'
  pool: 'FBA' | 'FBM_WAREHOUSE'
  isMcf: boolean
  publishedQty: number
  availableToPublish: number
  drift: number
}

export type PoolDriftResult = {
  rows: PoolDriftRow[]
  scanned: number
  oversold: number
  truncated: boolean
}

/**
 * Scan active channel listings and return those whose published quantity
 * exceeds what their pool can back (drift > 0), worst first.
 */
export async function computePoolDrift(
  opts: { productId?: string; limit?: number; includeHealthy?: boolean } = {},
): Promise<PoolDriftResult> {
  const limit = Math.min(Math.max(opts.limit ?? DEFAULT_LIMIT, 1), 5000)
  const listings = await prisma.channelListing.findMany({
    where: {
      listingStatus: { in: ACTIVE_STATUSES },
      quantity: { gt: 0 },
      ...(opts.productId ? { productId: opts.productId } : {}),
    },
    select: {
      productId: true,
      channel: true,
      marketplace: true,
      fulfillmentMethod: true,
      stockBuffer: true,
      quantity: true,
      product: { select: { sku: true, name: true, fulfillmentMethod: true } },
    },
    take: limit + 1,
  })
  const truncated = listings.length > limit
  const scan = truncated ? listings.slice(0, limit) : listings

  const productIds = [...new Set(scan.map((l) => l.productId))]
  const skus = [...new Set(scan.map((l) => l.product?.sku).filter((s): s is string => !!s))]

  const [whRows, fbaRows, pendingMcfByProduct] = await Promise.all([
    prisma.stockLevel.findMany({
      where: { productId: { in: productIds }, location: { type: 'WAREHOUSE' } },
      select: { productId: true, available: true },
    }),
    skus.length > 0
      ? prisma.fbaInventoryDetail.findMany({
          where: { sku: { in: skus }, condition: 'SELLABLE' },
          select: { sku: true, quantity: true, marketplaceId: true },
        })
      : Promise.resolve([] as Array<{ sku: string; quantity: number; marketplaceId: string }>),
    getPendingMcfReservedByProduct(productIds),
  ])

  const warehouseByProduct = new Map<string, number>()
  for (const r of whRows) warehouseByProduct.set(r.productId, (warehouseByProduct.get(r.productId) ?? 0) + r.available)
  const fbaBySkuMarket = new Map<string, number>()
  for (const r of fbaRows) {
    const code = MARKETPLACE_ID_TO_CODE[r.marketplaceId] ?? r.marketplaceId
    const key = `${r.sku}::${code}`
    fbaBySkuMarket.set(key, (fbaBySkuMarket.get(key) ?? 0) + r.quantity)
  }

  const rows: PoolDriftRow[] = []
  for (const l of scan) {
    const productMethod = (l.product?.fulfillmentMethod as 'FBA' | 'FBM' | null) ?? null
    let method = l.fulfillmentMethod as 'FBA' | 'FBM' | null
    if (method == null) {
      method = MERCHANT_CHANNELS.has(l.channel) ? 'FBM' : productMethod ?? 'FBM'
    }
    const code = (l.marketplace ?? '').toUpperCase()
    const sku = l.product?.sku ?? null
    const atp = computeAvailableToPublish({
      fulfillmentMethod: method,
      warehouseAvailable: warehouseByProduct.get(l.productId) ?? 0,
      fbaSellable: sku ? fbaBySkuMarket.get(`${sku}::${code}`) ?? 0 : 0,
      stockBuffer: l.stockBuffer ?? 0,
      pendingReserved: method === 'FBA' ? pendingMcfByProduct.get(l.productId) ?? 0 : 0,
    })
    const publishedQty = l.quantity ?? 0
    const drift = publishedQty - atp.available
    if (drift <= 0 && !opts.includeHealthy) continue
    rows.push({
      productId: l.productId,
      sku: sku ?? '',
      name: l.product?.name ?? null,
      channel: l.channel,
      marketplace: l.marketplace,
      fulfillmentMethod: method,
      pool: atp.pool,
      isMcf: MERCHANT_CHANNELS.has(l.channel) && method === 'FBA',
      publishedQty,
      availableToPublish: atp.available,
      drift,
    })
  }
  rows.sort((a, b) => b.drift - a.drift)

  return {
    rows,
    scanned: scan.length,
    oversold: rows.filter((r) => r.drift > 0).length,
    truncated,
  }
}
