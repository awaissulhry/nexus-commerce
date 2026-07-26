/**
 * SCT.6 — per-market Amazon offer CLOSE / REOPEN.
 *
 * The owner's lever for "don't sell FBM in DE/FR/ES (expensive cross-border
 * shipping) while IT keeps selling" — the thing quantity can NEVER do on
 * Amazon EU (one shared number per SKU, proved 2026-07-26 twice).
 *
 * CLOSE = Amazon's documented mechanism: delete the marketplace's
 * purchasable_offer attribute instance. The listing goes Inactive (no offer)
 * in that ONE marketplace. SKU record, content, ASIN, REVIEWS (ASIN-level),
 * sibling markets and the shared EU quantity are untouched.
 * REOPEN = replay the verbatim purchasable_offer captured at close time, then
 * rejoin the pool (Set Follow) so the quantity flows on the next cascade.
 *
 * Hard rules:
 *   - FBA rows are REFUSED fail-closed (Amazon manages their logistics —
 *     closing them is never our concern, per the owner).
 *   - A live snapshot is taken BEFORE closing; without a usable offer
 *     snapshot we still close but record snapshotSource:'db' so reopen
 *     rebuilds the price from our own columns.
 *   - Pending quantity pushes for the closing row are CANCELLED so nothing
 *     races the close.
 *   - Partial-honest contract like every other bulk primitive: results per
 *     row, error/remaining on mid-bulk failure, nothing silent.
 */

import prisma from '../db.js'
import { amazonSpApiClient } from '../clients/amazon-sp-api.client.js'
import { MARKETPLACE_ID_MAP } from './amazon/flat-file.service.js'
import { logger } from '../utils/logger.js'

export interface MarketOfferTarget {
  productId: string
  marketplace: string
}

export interface MarketOfferRowResult {
  productId: string
  sku: string | null
  marketplace: string
  action: 'CLOSED' | 'REOPENED' | 'SKIPPED_FBA' | 'SKIPPED_ALREADY' | 'SKIPPED_NOT_CLOSED' | 'SKIPPED_NO_LISTING' | 'FAILED'
  detail?: string
}

export interface MarketOfferResult {
  updated: number
  skippedFba: number
  unchanged: number
  failed: number
  results: MarketOfferRowResult[]
  /** Mid-bulk stop: message + rows not attempted (same contract as follow-master). */
  error?: string
  remaining?: number
}

const sellerId = () => process.env.AMAZON_SELLER_ID ?? process.env.AMAZON_MERCHANT_ID ?? ''

function isFbaRow(cl: { fulfillmentMethod: string | null; product: { fulfillmentMethod: string | null } | null }): boolean {
  // Fail-closed: ANY FBA signal refuses the close/reopen. Amazon owns FBA
  // logistics end-to-end — these offers are never ours to close.
  return cl.fulfillmentMethod === 'FBA' || cl.product?.fulfillmentMethod === 'FBA'
}

async function loadRow(t: MarketOfferTarget) {
  return prisma.channelListing.findFirst({
    where: { productId: t.productId, channel: 'AMAZON', marketplace: t.marketplace },
    select: {
      id: true, productId: true, marketplace: true, fulfillmentMethod: true,
      offerClosedAt: true, offerCloseSnapshot: true, price: true,
      platformAttributes: true, followMasterQuantity: true, quantityOverride: true, syncPaused: true,
      product: { select: { sku: true, fulfillmentMethod: true, productType: true } },
    },
  })
}

/** The marketplace's purchasable_offer instances from a live attributes read. */
function offerInstancesFor(attrs: Record<string, unknown> | null | undefined, marketplaceId: string): Array<Record<string, unknown>> {
  const po = (attrs as { purchasable_offer?: Array<Record<string, unknown>> } | null | undefined)?.purchasable_offer
  if (!Array.isArray(po)) return []
  return po.filter((x) => x && (x.marketplace_id === marketplaceId || po.length === 1))
}

export async function closeMarketOffers(opts: {
  targets: MarketOfferTarget[]
  actor: string
  reason?: string
}): Promise<MarketOfferResult> {
  const result: MarketOfferResult = { updated: 0, skippedFba: 0, unchanged: 0, failed: 0, results: [] }
  const seller = sellerId()
  if (!seller) throw new Error('AMAZON_SELLER_ID not configured')

  let processed = 0
  for (const t of opts.targets) {
    try {
      const cl = await loadRow(t)
      const sku = cl?.product?.sku ?? null
      if (!cl || !sku) {
        result.results.push({ productId: t.productId, sku, marketplace: t.marketplace, action: 'SKIPPED_NO_LISTING' })
        result.unchanged++
        processed++
        continue
      }
      if (isFbaRow(cl)) {
        // Owner rule: FBA is Amazon-managed — never close it.
        result.results.push({ productId: t.productId, sku, marketplace: t.marketplace, action: 'SKIPPED_FBA' })
        result.skippedFba++
        processed++
        continue
      }
      if (cl.offerClosedAt) {
        result.results.push({ productId: t.productId, sku, marketplace: t.marketplace, action: 'SKIPPED_ALREADY' })
        result.unchanged++
        processed++
        continue
      }
      const marketplaceId = MARKETPLACE_ID_MAP[t.marketplace.toUpperCase()]
      if (!marketplaceId) {
        result.results.push({ productId: t.productId, sku, marketplace: t.marketplace, action: 'FAILED', detail: `unknown marketplace ${t.marketplace}` })
        result.failed++
        processed++
        continue
      }

      // 1 — live snapshot BEFORE closing (verbatim purchasable_offer).
      let snapshotSource: 'live' | 'db' = 'live'
      let offerValue: Array<Record<string, unknown>> = []
      let productType =
        String((cl.platformAttributes as { productType?: string } | null)?.productType ?? cl.product?.productType ?? '').toUpperCase()
      try {
        const live = await amazonSpApiClient.getListingsItem({
          sellerId: seller, sku, marketplaceId, includedData: ['attributes', 'summaries'],
        } as never)
        const raw = (live as { rawResponse?: { attributes?: Record<string, unknown>; summaries?: Array<{ productType?: string }> } }).rawResponse
        offerValue = offerInstancesFor(raw?.attributes, marketplaceId)
        const liveType = raw?.summaries?.[0]?.productType
        if (liveType) productType = String(liveType).toUpperCase()
      } catch (snapErr) {
        logger.warn('market-offer close: live snapshot read failed (DB fallback)', {
          sku, marketplaceId, error: snapErr instanceof Error ? snapErr.message : String(snapErr),
        })
      }
      if (offerValue.length === 0) {
        // Diagnostic (SCT.6 pilot found 'db' fallback on a healthy listing):
        // record WHAT the live read returned so snapshot fidelity is provable.
        logger.warn('market-offer close: no live purchasable_offer instance — using DB price snapshot', { sku, marketplaceId })
        snapshotSource = 'db'
        offerValue = [{
          marketplace_id: marketplaceId,
          currency: 'EUR',
          our_price: [{ schedule: [{ value_with_tax: cl.price ?? 0 }] }],
        }]
      }
      if (!productType) {
        result.results.push({ productId: t.productId, sku, marketplace: t.marketplace, action: 'FAILED', detail: 'no productType resolvable — cannot patch' })
        result.failed++
        processed++
        continue
      }

      // 2 — the close patch (delete THIS marketplace's offer instance).
      const selector = offerValue.map((x) => ({
        marketplace_id: marketplaceId,
        ...(x.currency ? { currency: x.currency } : {}),
        ...(x.audience ? { audience: x.audience } : {}),
      }))
      const res = await amazonSpApiClient.patchPurchasableOffer({
        sellerId: seller, sku, marketplaceId, productType, op: 'delete', value: selector,
      })
      if (!res.success) {
        result.results.push({ productId: t.productId, sku, marketplace: t.marketplace, action: 'FAILED', detail: res.error })
        result.failed++
        processed++
        continue
      }

      // 3 — persist the closed state + cancel racing quantity pushes.
      await prisma.channelListing.update({
        where: { id: cl.id },
        data: {
          offerClosedAt: new Date(),
          offerClosedBy: opts.actor,
          offerCloseReason: opts.reason ?? null,
          offerCloseSnapshot: {
            purchasableOffer: offerValue,
            productType,
            snapshotSource,
            control: {
              followMasterQuantity: cl.followMasterQuantity,
              quantityOverride: cl.quantityOverride,
              syncPaused: cl.syncPaused,
            },
          } as never,
        },
      })
      await prisma.outboundSyncQueue.updateMany({
        where: { channelListingId: cl.id, syncStatus: 'PENDING' },
        data: { syncStatus: 'CANCELLED', errorMessage: 'market offer closed (SCT.6)' },
      })
      result.results.push({ productId: t.productId, sku, marketplace: t.marketplace, action: 'CLOSED', detail: res.dryRun ? 'dry-run' : undefined })
      result.updated++
      processed++
    } catch (e) {
      if (processed === 0) throw e
      result.error = e instanceof Error ? e.message : String(e)
      result.remaining = opts.targets.length - processed
      logger.error('market-offer close stopped mid-bulk', { processed, remaining: result.remaining, error: result.error })
      break
    }
  }
  logger.info('market-offer close applied', { actor: opts.actor, updated: result.updated, skippedFba: result.skippedFba, failed: result.failed })
  return result
}

export async function reopenMarketOffers(opts: {
  targets: MarketOfferTarget[]
  actor: string
}): Promise<MarketOfferResult> {
  const result: MarketOfferResult = { updated: 0, skippedFba: 0, unchanged: 0, failed: 0, results: [] }
  const seller = sellerId()
  if (!seller) throw new Error('AMAZON_SELLER_ID not configured')

  let processed = 0
  for (const t of opts.targets) {
    try {
      const cl = await loadRow(t)
      const sku = cl?.product?.sku ?? null
      if (!cl || !sku) {
        result.results.push({ productId: t.productId, sku, marketplace: t.marketplace, action: 'SKIPPED_NO_LISTING' })
        result.unchanged++
        processed++
        continue
      }
      if (isFbaRow(cl)) {
        result.results.push({ productId: t.productId, sku, marketplace: t.marketplace, action: 'SKIPPED_FBA' })
        result.skippedFba++
        processed++
        continue
      }
      if (!cl.offerClosedAt) {
        result.results.push({ productId: t.productId, sku, marketplace: t.marketplace, action: 'SKIPPED_NOT_CLOSED' })
        result.unchanged++
        processed++
        continue
      }
      const marketplaceId = MARKETPLACE_ID_MAP[t.marketplace.toUpperCase()]
      const snap = cl.offerCloseSnapshot as {
        purchasableOffer?: Array<Record<string, unknown>>
        productType?: string
      } | null
      const offerValue = snap?.purchasableOffer ?? []
      const productType = String(snap?.productType ?? (cl.platformAttributes as { productType?: string } | null)?.productType ?? cl.product?.productType ?? '').toUpperCase()
      if (!marketplaceId || offerValue.length === 0 || !productType) {
        result.results.push({
          productId: t.productId, sku, marketplace: t.marketplace, action: 'FAILED',
          detail: 'no usable close snapshot — reopen needs a manual price set (edit price, then Set Follow)',
        })
        result.failed++
        processed++
        continue
      }

      // Replay the verbatim offer (op:replace also creates it when absent).
      const res = await amazonSpApiClient.patchPurchasableOffer({
        sellerId: seller, sku, marketplaceId, productType, op: 'replace', value: offerValue,
      })
      if (!res.success) {
        result.results.push({ productId: t.productId, sku, marketplace: t.marketplace, action: 'FAILED', detail: res.error })
        result.failed++
        processed++
        continue
      }

      // Rejoin the pool: Follow + fresh push so quantity flows immediately.
      await prisma.channelListing.update({
        where: { id: cl.id },
        data: {
          offerClosedAt: null,
          offerClosedBy: null,
          offerCloseReason: null,
          // snapshot kept for audit/history — cheap and occasionally useful.
          followMasterQuantity: true,
          quantityOverride: null,
          lastSyncStatus: 'PENDING',
          lastSyncedAt: null,
        },
      })
      await prisma.outboundSyncQueue.create({
        data: {
          productId: cl.productId,
          channelListingId: cl.id,
          targetChannel: 'AMAZON',
          targetRegion: cl.marketplace,
          syncType: 'QUANTITY_UPDATE',
          syncStatus: 'PENDING',
          holdUntil: new Date(),
          maxRetries: 3,
          payload: { source: 'SCT6_REOPEN', productId: cl.productId, marketplace: cl.marketplace, actor: opts.actor },
        },
      })
      result.results.push({ productId: t.productId, sku, marketplace: t.marketplace, action: 'REOPENED', detail: res.dryRun ? 'dry-run' : undefined })
      result.updated++
      processed++
    } catch (e) {
      if (processed === 0) throw e
      result.error = e instanceof Error ? e.message : String(e)
      result.remaining = opts.targets.length - processed
      logger.error('market-offer reopen stopped mid-bulk', { processed, remaining: result.remaining, error: result.error })
      break
    }
  }
  logger.info('market-offer reopen applied', { actor: opts.actor, updated: result.updated, failed: result.failed })
  return result
}

/** SCT.6 belt helper — is this (productId, marketplace) closed? Used by every
 *  Amazon write stack so nothing can silently resurrect a closed offer. */
export async function closedMarketSet(productIds: string[]): Promise<Set<string>> {
  if (productIds.length === 0) return new Set()
  const rows = await prisma.channelListing.findMany({
    where: { productId: { in: productIds }, channel: 'AMAZON', offerClosedAt: { not: null } },
    select: { productId: true, marketplace: true },
  })
  return new Set(rows.map((r) => `${r.productId}|${r.marketplace.toUpperCase()}`))
}

export async function isMarketClosedBySku(sku: string, marketplaceCodeOrId: string): Promise<boolean> {
  // Accepts either a country code (DE) or an SP-API marketplace id.
  const code = Object.entries(MARKETPLACE_ID_MAP).find(([, id]) => id === marketplaceCodeOrId)?.[0] ?? marketplaceCodeOrId
  const row = await prisma.channelListing.findFirst({
    where: {
      channel: 'AMAZON',
      marketplace: { equals: code, mode: 'insensitive' },
      offerClosedAt: { not: null },
      product: { sku },
    },
    select: { id: true },
  })
  return !!row
}
