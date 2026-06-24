/**
 * FBA restore service — shared core for re-asserting AMAZON_EU fulfillment.
 *
 * Used by:
 *  - POST /admin/amazon/restore-fba   (manual recovery)
 *  - fba-drift-detector cron          (auto-restore on external drift)
 *  - fba-flip-guard cron              (auto-restore on Nexus-origin flip)
 *
 * Sends a Listings Items PATCH that sets fulfillment_availability back to
 * AMAZON_EU (no quantity — Amazon manages FBA stock) for every AMAZON
 * ChannelListing that is backed by FBA stock on hand. Callers can narrow the
 * scope with optional sku / marketplace filters.
 *
 * dryRun defaults to TRUE — callers must explicitly pass dryRun:false to
 * send to Amazon. Honouring the publish gate is the responsibility of
 * amazonSpApiClient.submitListingPayload().
 */

import prisma from '../db.js'
import { amazonSpApiClient } from '../clients/amazon-sp-api.client.js'
import { logger } from '../utils/logger.js'

const AMZ_MP_ID: Record<string, string> = {
  IT: 'APJ6JRA9NG5V4',
  DE: 'A1PA6795UKMFR9',
  FR: 'A13V1IB3VIYZZH',
  ES: 'A1RKKUPIHCS9HS',
  UK: 'A1F83G8C2ARO7P',
}

export interface FbaRestoreItemResult {
  sku: string
  marketplace: string
  productType: string
  dryRun: boolean
  ok?: boolean
  status?: string
  error?: string
}

export interface FbaRestoreSummary {
  dryRun: boolean
  processed: number
  sent: number
  skippedNoFba: number
  results: FbaRestoreItemResult[]
}

/**
 * Re-assert FBA fulfillment channel for Amazon listings backed by FBA stock.
 *
 * @param options.skus        Restrict to these SKUs (all FBA SKUs if omitted)
 * @param options.marketplaces Restrict to these marketplace codes (all if omitted)
 * @param options.dryRun      true = simulate only (default); false = actually PATCHes Amazon
 * @param options.limit       Cap total listings processed (useful for canary runs)
 */
export async function restoreFbaListings(options?: {
  skus?: string[]
  marketplaces?: string[]
  dryRun?: boolean
  limit?: number
}): Promise<FbaRestoreSummary> {
  const { skus, marketplaces, dryRun = true, limit } = options ?? {}

  const sellerId = process.env.AMAZON_SELLER_ID ?? process.env.AMAZON_MERCHANT_ID ?? ''
  if (!sellerId) throw new Error('AMAZON_SELLER_ID not configured')

  const listings = await prisma.channelListing.findMany({
    where: {
      channel: 'AMAZON',
      ...(skus?.length ? { product: { sku: { in: skus } } } : {}),
      ...(marketplaces?.length ? { marketplace: { in: marketplaces } } : {}),
    },
    select: {
      id: true,
      marketplace: true,
      platformAttributes: true,
      product: { select: { id: true, sku: true, productType: true } },
    },
    orderBy: { id: 'asc' },
  })

  const results: FbaRestoreItemResult[] = []
  let processed = 0, sent = 0, skippedNoFba = 0

  for (const cl of listings) {
    if (limit !== undefined && processed >= limit) break
    const sku = cl.product?.sku
    if (!sku || !cl.product?.id) continue

    // Only restore listings backed by live FBA stock — the at-risk set.
    const agg = await prisma.stockLevel
      .aggregate({
        where: { productId: cl.product.id, location: { code: 'AMAZON-EU-FBA' } },
        _sum: { quantity: true },
      })
      .catch(() => null)

    if (!(agg?._sum.quantity && agg._sum.quantity > 0)) {
      skippedNoFba++
      continue
    }

    processed++
    const marketplaceId = AMZ_MP_ID[cl.marketplace] ?? AMZ_MP_ID.IT
    const productType = String(
      (cl.platformAttributes as Record<string, unknown>)?.productType ??
        cl.product?.productType ??
        '',
    ).toUpperCase()

    const payload = {
      productType: productType || 'PRODUCT',
      patches: [
        {
          op: 'replace',
          path: '/attributes/fulfillment_availability',
          value: [{ fulfillment_channel_code: 'AMAZON_EU', marketplace_id: marketplaceId }],
        },
      ],
    }

    if (dryRun) {
      results.push({ sku, marketplace: cl.marketplace, productType: payload.productType, dryRun: true })
      continue
    }

    try {
      const r = await amazonSpApiClient.submitListingPayload({ sellerId, sku, payload })
      sent++
      logger.info('fba-restore: re-asserted AMAZON_EU', {
        sku,
        marketplace: cl.marketplace,
        ok: r.success,
        status: r.status,
      })
      results.push({
        sku,
        marketplace: cl.marketplace,
        productType: payload.productType,
        dryRun: false,
        ok: r.success,
        status: r.status,
        error: r.error,
      })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      logger.error('fba-restore: PATCH failed', { sku, marketplace: cl.marketplace, error: msg })
      results.push({
        sku,
        marketplace: cl.marketplace,
        productType: payload.productType,
        dryRun: false,
        ok: false,
        error: msg,
      })
    }
  }

  return { dryRun, processed, sent, skippedNoFba, results }
}
