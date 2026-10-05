import { getAmazonSellerId } from '../lib/amazon-sp-client.js'
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
 *
 * A listing that carries an Amazon-only FBA code (Remote Fulfilment, VCS — set in
 * Seller Central) in either place is skipped: the whole-root replace would
 * overwrite that code with AMAZON_EU. It is FBA already; nothing to restore.
 */

import { assertPushAllowed } from '@nexus/shared/push-lock'
import { closedMarketSet } from './amazon-market-offer.service.js'
import prisma from '../db.js'
import { amazonSpApiClient } from '../clients/amazon-sp-api.client.js'
import { logger } from '../utils/logger.js'
import { keptAmazonFulfilmentCodes } from '../lib/amazon-fulfilment-programme.js'
import { listingSendSku } from './listings/listing-send-sku.js'
import { isFbaCoordinate } from '../lib/amazon-fulfillment.js'

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
  /** Listings skipped because they carry an Amazon-only FBA code (Remote Fulfilment, VCS) the restore would overwrite. */
  skippedKeptCode: number
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

  const sellerId = (await getAmazonSellerId())
  if (!sellerId) throw new Error('AMAZON_SELLER_ID not configured')

  const listings = await prisma.channelListing.findMany({
    where: {
      channel: 'AMAZON',
      // S3 — a SKU names a listing by its product SKU (as before) or by the listing's own seller SKU.
      ...(skus?.length ? { OR: [{ product: { sku: { in: skus } } }, { liveChannelSku: { in: skus } }, { channelSku: { in: skus } }] } : {}),
      ...(marketplaces?.length ? { marketplace: { in: marketplaces } } : {}),
    },
    include: {
      product: { select: { id: true, sku: true, productType: true } },
      // S3 — the seller-SKU facts (`listingSendSku`) read the offers too.
      offers: { select: { sku: true, isActive: true, fulfillmentMethod: true }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] },
    },
    orderBy: { id: 'asc' },
  })

  const closed = await closedMarketSet(listings.map(row => row.product.id))
  const results: FbaRestoreItemResult[] = []
  let processed = 0, sent = 0, skippedNoFba = 0, skippedKeptCode = 0

  for (const cl of listings) {
    if (limit !== undefined && processed >= limit) break
    if (!cl.product?.sku || !cl.product?.id) continue
    // S3 (per-channel SKU) — the PATCH names the seller SKU Amazon holds for this listing: the product SKU unless it has
    // its own (a draft: the product SKU, as before). Two SKUs on record: reported, nothing sent.
    const held = listingSendSku({ ...cl, channel: 'AMAZON' }, cl.product.sku, cl.product.sku)
    const sku = held.sku ?? cl.product.sku
    // A caller that names SKUs (a drift or flip report) restores those seller SKUs only, never another one of the product.
    if (skus?.length && !skus.includes(sku)) continue

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
    // S3 — the FBA stock above is the PRODUCT's. A listing selling under its own seller SKU may be merchant-fulfilled
    // while another SKU holds those units, so it is restored only on its own FBA evidence (an FBA method or code on the
    // listing, or an active FBA offer): never flipped to FBA on another SKU's stock.
    if (held.sku !== null && held.sku !== cl.product.sku
      && !isFbaCoordinate({ fulfillmentMethod: cl.fulfillmentMethod, platformAttributes: cl.platformAttributes }, null)
      && !(cl.offers ?? []).some(o => o.isActive && o.fulfillmentMethod === 'FBA')) {
      skippedNoFba++
      continue
    }
    const kept = keptAmazonFulfilmentCodes(cl.platformAttributes)
    if (kept.length > 0) {
      skippedKeptCode++
      logger.info('fba-restore: skipped — the listing keeps an Amazon-only FBA code', { sku, marketplace: cl.marketplace, codes: kept })
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

    const refusal = assertPushAllowed({ ...cl, offerClosedAt: cl.offerClosedAt ?? (closed.has(`${cl.product.id}|${cl.marketplace}`) ? 'closed' : null) })
    if (refusal) {
      results.push({ sku, marketplace: cl.marketplace, productType: payload.productType, dryRun, ok: false, error: `${refusal.code}: ${refusal.sentence}` })
      continue
    }
    if (held.sku === null) {
      results.push({ sku, marketplace: cl.marketplace, productType: payload.productType, dryRun, ok: false, error: `${held.code}: ${held.refusal}` })
      continue
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

  return { dryRun, processed, sent, skippedNoFba, skippedKeptCode, results }
}
