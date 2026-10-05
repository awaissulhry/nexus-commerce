import { isFbaCoordinate } from '../lib/amazon-fulfillment.js'
export { isFbaCoordinate } from '../lib/amazon-fulfillment.js'
import { createOutboundRow } from './outbound-rows.js'
import { getAmazonSellerId } from '../lib/amazon-sp-client.js'
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
 * rejoin the pool (Set Follow) so the quantity flows on the next cascade. A
 * listing created Inactive (New listings, ND1 A) had no offer to capture: its
 * reopen sends the offer Nexus builds from its own data (amazon/offer-from-nexus.ts).
 *
 * Hard rules:
 *   - FBA rows are REFUSED fail-closed (Amazon manages their logistics —
 *     closing them is never our concern, per the owner) — unless the caller
 *     passes `allowFba` (only the listing-action engine's Pause / Resume offer,
 *     build shape v2, Owner 2026-10-04). Then the close deletes THIS market's
 *     purchasable_offer and nothing else (fulfillment_availability, Amazon's
 *     FBA quantity, is never in the patch), and the reopen replays the saved
 *     offer WITHOUT rejoining the pool: no Set Follow, no quantity sent.
 *   - A live snapshot is taken BEFORE closing; without a usable offer
 *     snapshot we still close but record snapshotSource:'db' so reopen
 *     rebuilds the price from our own columns.
 *   - Pending quantity pushes for the closing row are CANCELLED so nothing
 *     races the close.
 *   - Partial-honest contract like every other bulk primitive: results per
 *     row, error/remaining on mid-bulk failure, nothing silent.
 */

import prisma from '../db.js'
import { whereCoordinate, type ListingCoordinate } from '../lib/listing-coordinate.js'
import { detectEuIntentConflict, EU_GUARD_REMEDY } from './amazon-eu-quantity-guard.js'
import { amazonSpApiClient } from '../clients/amazon-sp-api.client.js'
import { MARKETPLACE_ID_MAP } from './amazon/flat-file.service.js'
import { readAmazonOfferLive, type AmazonOfferLiveRead } from './amazon/purchasable-offer.js'
import { listingSendSku, sharesAmazonSellerSku } from './listings/listing-send-sku.js'
import { logger } from '../utils/logger.js'

export type { AmazonOfferLiveRead } from './amazon/purchasable-offer.js'

export interface MarketOfferTarget extends Omit<ListingCoordinate, 'channel'> {}

export interface MarketOfferRowResult {
  productId: string
  sku: string | null
  marketplace: string
  action: 'DRY_RUN' | 'CLOSED' | 'REOPENED' | 'SKIPPED_FBA' | 'SKIPPED_ALREADY' | 'SKIPPED_NOT_CLOSED' | 'SKIPPED_NO_LISTING' | 'FAILED'
  detail?: string
  /** An FBA offer closed or reopened under `allowFba` (its quantity was not touched). */
  fba?: boolean
  /** Reopened with an offer Nexus built from its own data (no offer was saved: a listing created Inactive). */
  fromNexus?: boolean
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


/** The seller-SKU facts of a listing (`listingSendSku`, S3): the two SKU columns, the draft facts, the offers, the mirror. */
const SELLER_SKU_SELECT = {
  channelSku: true, liveChannelSku: true, listingStatus: true, isPublished: true, externalListingId: true, flatFileSnapshot: true,
  offers: { select: { sku: true, isActive: true, fulfillmentMethod: true }, orderBy: [{ createdAt: 'asc' as const }, { id: 'asc' as const }] },
}

async function loadRow(t: MarketOfferTarget) {
  return prisma.channelListing.findFirst({
    where: whereCoordinate({ ...t, channel: 'AMAZON' }),
    select: {
      id: true, productId: true, channel: true, marketplace: true, channelConnectionId: true, aliasKey: true, fulfillmentMethod: true,
      offerClosedAt: true, offerCloseSnapshot: true, price: true,
      platformAttributes: true, followMasterQuantity: true, quantityOverride: true, syncPaused: true,
      ...SELLER_SKU_SELECT,
      product: { select: { sku: true, fulfillmentMethod: true, productType: true } },
    },
  })
}

type OfferRow = NonNullable<Awaited<ReturnType<typeof loadRow>>>

/**
 * S3 (per-channel SKU) — the seller SKU Amazon holds for this listing: the product SKU unless it has its own (a draft:
 * the product SKU, as before). `refusal` when two SKUs are on record: nothing is sent for that row.
 */
function sellerSkuOf(cl: OfferRow, productSku: string): { sku: string | null; refusal: string | null } {
  const held = listingSendSku({ ...cl, channel: 'AMAZON' }, productSku, productSku)
  return { sku: held.sku, refusal: held.refusal }
}

type OfferPatchResult = Awaited<ReturnType<typeof amazonSpApiClient.patchPurchasableOffer>>

export interface AmazonOfferCloseAttempt {
  sent: boolean
  /** Why nothing was sent (sent=false). */
  notSent?: 'LIVE_READ_FAILED' | 'NO_LIVE_OFFER' | 'NO_PRODUCT_TYPE' | 'REFUSED'
  detail?: string
  /** The patch answer (sent=true). */
  res?: OfferPatchResult
  /** The verbatim purchasable_offer the close removes — what a reopen replays. */
  snapshot: Array<Record<string, unknown>>
  snapshotSource: 'live' | 'db'
  productType: string
  live: AmazonOfferLiveRead
}

/**
 * PLAN Step 1.3 (R-39) — SCT.6's CHANNEL half, one owner for both callers: `closeMarketOffers`
 * (the per-market close, which then records the closure on its row) and the hard-delete
 * unpublish (`channel-delist.service.ts`, which runs after the row is gone).
 *
 * 1. a live read (the verbatim purchasable_offer + the fulfilment channels);
 * 2. the caller's `refuse` check — a reason sends nothing;
 * 3. the close: delete THIS marketplace's offer instance by its selectors
 *    ({marketplace_id, currency?, audience?}) — proved live 2026-09-23 (A-38 results).
 *
 * `dbFallback` is SCT.6's own rule: with no usable live offer it still closes, snapshotting our
 * price (snapshotSource 'db'). Without it, a failed read or a missing offer sends nothing.
 */
export async function closeAmazonOfferOnChannel(input: {
  sellerId: string
  sku: string
  marketplaceId: string
  /** The stored product type; the live read's own type wins when it names one. */
  productType: string
  dbFallback?: { price: unknown }
  refuse?: (live: AmazonOfferLiveRead) => string | null
}): Promise<AmazonOfferCloseAttempt> {
  const { sellerId, sku, marketplaceId } = input
  let productType = String(input.productType ?? '').toUpperCase()
  // The one live reader (amazon/purchasable-offer.ts), shared with the queue's price push.
  const live: AmazonOfferLiveRead = await readAmazonOfferLive({ sellerId, sku, marketplaceId })
  if (live.productType) productType = live.productType
  if (live.read === 'failed') {
    logger.warn('market-offer close: live snapshot read failed', { sku, marketplaceId, error: live.error, dbFallback: !!input.dbFallback })
  }

  let snapshotSource: 'live' | 'db' = 'live'
  let offerValue = live.offers
  const notSent = (reason: NonNullable<AmazonOfferCloseAttempt['notSent']>, detail?: string): AmazonOfferCloseAttempt =>
    ({ sent: false, notSent: reason, detail, snapshot: offerValue, snapshotSource, productType, live })
  if (!input.dbFallback) {
    if (live.read === 'failed') return notSent('LIVE_READ_FAILED', live.error)
    const refusal = input.refuse?.(live) ?? null
    if (refusal) return notSent('REFUSED', refusal)
    if (offerValue.length === 0) return notSent('NO_LIVE_OFFER')
  } else if (offerValue.length === 0) {
    // Diagnostic (SCT.6 pilot found 'db' fallback on a healthy listing):
    // record WHAT the live read returned so snapshot fidelity is provable.
    logger.warn('market-offer close: no live purchasable_offer instance — using DB price snapshot', { sku, marketplaceId })
    snapshotSource = 'db'
    offerValue = [{
      marketplace_id: marketplaceId,
      currency: 'EUR',
      our_price: [{ schedule: [{ value_with_tax: input.dbFallback.price ?? 0 }] }],
    }]
  }
  if (!productType) return notSent('NO_PRODUCT_TYPE', 'no productType resolvable — cannot patch')

  // The close patch (delete THIS marketplace's offer instance).
  const selector = offerValue.map((x) => ({
    marketplace_id: marketplaceId,
    ...(x.currency ? { currency: x.currency } : {}),
    ...(x.audience ? { audience: x.audience } : {}),
  }))
  const res = await amazonSpApiClient.patchPurchasableOffer({
    sellerId, sku, marketplaceId, productType, op: 'delete', value: selector,
  })
  return { sent: true, res, snapshot: offerValue, snapshotSource, productType, live }
}

export async function closeMarketOffers(opts: {
  targets: MarketOfferTarget[]
  actor: string
  reason?: string
  /** Close FBA offers too (the listing-action engine's Pause offer only). The FBA quantity is never touched. */
  allowFba?: boolean
}): Promise<MarketOfferResult> {
  const result: MarketOfferResult = { updated: 0, skippedFba: 0, unchanged: 0, failed: 0, results: [] }
  // Validate the whole batch before the first side effect.
  opts.targets.forEach(t => whereCoordinate({ ...t, channel: 'AMAZON' }))

  let processed = 0
  for (const t of opts.targets) {
    try {
      const cl = await loadRow(t)
      const productSku = cl?.product?.sku ?? null
      if (!cl || !productSku) {
        result.results.push({ productId: t.productId, sku: productSku, marketplace: t.marketplace, action: 'SKIPPED_NO_LISTING' })
        result.unchanged++
        processed++
        continue
      }
      const held = sellerSkuOf(cl, productSku)
      const sku = held.sku ?? productSku
      const fba = isFbaCoordinate(cl)
      if (fba && !opts.allowFba) {
        // Owner rule: FBA is Amazon-managed — never close it (outside the engine's Pause offer).
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
      if (!held.sku) {
        // S3 — two seller SKUs on record: nothing is sent (a guess could close or reopen another listing's offer).
        result.results.push({ productId: t.productId, sku, marketplace: t.marketplace, action: 'FAILED', detail: held.refusal ?? undefined })
        result.failed++
        processed++
        continue
      }
      if (!t.channelConnectionId) throw new Error('AMAZON_OFFER_ACCOUNT_REQUIRED')
      const seller = await getAmazonSellerId(t.channelConnectionId)
      if (!seller) throw new Error('AMAZON_SELLER_ID not configured for coordinate account')
      const marketplaceId = MARKETPLACE_ID_MAP[t.marketplace.toUpperCase()]
      if (!marketplaceId) {
        result.results.push({ productId: t.productId, sku, marketplace: t.marketplace, action: 'FAILED', detail: `unknown marketplace ${t.marketplace}` })
        result.failed++
        processed++
        continue
      }

      // 1 + 2 — live snapshot BEFORE closing (verbatim purchasable_offer), then the close patch
      // (delete THIS marketplace's offer instance). The channel half is shared with the
      // hard-delete unpublish (PLAN Step 1.3); SCT.6 keeps its DB-price fallback.
      const attempt = await closeAmazonOfferOnChannel({
        sellerId: seller, sku, marketplaceId,
        productType: String((cl.platformAttributes as { productType?: string } | null)?.productType ?? cl.product?.productType ?? ''),
        dbFallback: { price: cl.price },
      })
      const { snapshot: offerValue, snapshotSource, productType } = attempt
      if (!attempt.sent || !attempt.res) {
        result.results.push({ productId: t.productId, sku, marketplace: t.marketplace, action: 'FAILED', detail: attempt.detail ?? 'no productType resolvable — cannot patch' })
        result.failed++
        processed++
        continue
      }
      const res = attempt.res
      if (!res.success) {
        result.results.push({ productId: t.productId, sku, marketplace: t.marketplace, action: 'FAILED', detail: res.error })
        result.failed++
        processed++
        continue
      }

      if (res.dryRun) {
        result.results.push({ productId: t.productId, sku, marketplace: t.marketplace, action: 'DRY_RUN', detail: 'Preview only; offer state unchanged.' })
        result.unchanged++; processed++; continue
      }

      // 3 — persist only an acknowledged close; skip_offer consumes offerActive.
      await prisma.channelListing.update({
        where: { id: cl.id, ...whereCoordinate({ ...t, channel: 'AMAZON' }) },
        data: {
          offerClosedAt: new Date(),
          offerActive: false,
          offerClosedBy: opts.actor,
          offerCloseReason: opts.reason ?? null,
          offerCloseSnapshot: {
            purchasableOffer: offerValue,
            productType,
            snapshotSource,
            ...(fba ? { fulfillment: 'FBA' } : {}),
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
      result.results.push({ productId: t.productId, sku, marketplace: t.marketplace, action: 'CLOSED', detail: undefined, ...(fba ? { fba: true } : {}) })
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
  /** Reopen FBA offers too (the engine's Resume offer only): the offer is replayed; no pool, no quantity. */
  allowFba?: boolean
}): Promise<MarketOfferResult> {
  const result: MarketOfferResult = { updated: 0, skippedFba: 0, unchanged: 0, failed: 0, results: [] }
  // Validate the whole batch before the first side effect.
  opts.targets.forEach(t => whereCoordinate({ ...t, channel: 'AMAZON' }))

  let processed = 0
  for (const t of opts.targets) {
    try {
      const cl = await loadRow(t)
      const productSku = cl?.product?.sku ?? null
      if (!cl || !productSku) {
        result.results.push({ productId: t.productId, sku: productSku, marketplace: t.marketplace, action: 'SKIPPED_NO_LISTING' })
        result.unchanged++
        processed++
        continue
      }
      const held = sellerSkuOf(cl, productSku)
      const sku = held.sku ?? productSku
      const fba = isFbaCoordinate(cl)
      if (fba && !opts.allowFba) {
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
      if (!held.sku) {
        // S3 — two seller SKUs on record: nothing is sent (a guess could close or reopen another listing's offer).
        result.results.push({ productId: t.productId, sku, marketplace: t.marketplace, action: 'FAILED', detail: held.refusal ?? undefined })
        result.failed++
        processed++
        continue
      }
      if (!t.channelConnectionId) throw new Error('AMAZON_OFFER_ACCOUNT_REQUIRED')
      const seller = await getAmazonSellerId(t.channelConnectionId)
      if (!seller) throw new Error('AMAZON_SELLER_ID not configured for coordinate account')
      const marketplaceId = MARKETPLACE_ID_MAP[t.marketplace.toUpperCase()]
      const snap = cl.offerCloseSnapshot as {
        purchasableOffer?: Array<Record<string, unknown>>
        productType?: string
      } | null
      let offerValue = snap?.purchasableOffer ?? []
      const productType = String(snap?.productType ?? (cl.platformAttributes as { productType?: string } | null)?.productType ?? cl.product?.productType ?? '').toUpperCase()
      // New listings (ND1 A) — no offer was saved (a listing created Inactive never had one here): Nexus builds it from
      // its own data (price, offer settings), with the rules a new listing's offer follows. Nothing is sent if it cannot.
      let fromNexus = false
      if (marketplaceId && productType && offerValue.length === 0) {
        const { nexusPurchasableOffer } = await import('./amazon/offer-from-nexus.js')
        const built = await nexusPurchasableOffer(cl.id)
        if ('refusal' in built) {
          result.results.push({ productId: t.productId, sku, marketplace: t.marketplace, action: 'FAILED', detail: `No saved offer to put back, and Nexus could not build one: ${built.refusal}` })
          result.failed++
          processed++
          continue
        }
        offerValue = built.offer
        fromNexus = true
      }
      if (!marketplaceId || offerValue.length === 0 || !productType) {
        result.results.push({
          productId: t.productId, sku, marketplace: t.marketplace, action: 'FAILED',
          detail: 'no usable close snapshot — reopen needs a manual price set (edit price, then Set Follow)',
        })
        result.failed++
        processed++
        continue
      }

      if (fba) {
        // FBA: Amazon owns the quantity. Replay the offer only — no EU quantity guard (no merchant quantity
        // moves), no Set Follow, no quantity queued; the row's own stock controls stay as they were.
        const res = await amazonSpApiClient.patchPurchasableOffer({
          sellerId: seller, sku, marketplaceId, productType, op: 'replace', value: offerValue,
        })
        if (!res.success) {
          result.results.push({ productId: t.productId, sku, marketplace: t.marketplace, action: 'FAILED', detail: res.error, fba: true })
          result.failed++
          processed++
          continue
        }
        if (res.dryRun) {
          result.results.push({ productId: t.productId, sku, marketplace: t.marketplace, action: 'DRY_RUN', detail: 'Preview only; offer state unchanged.', fba: true })
          result.unchanged++; processed++; continue
        }
        await prisma.channelListing.update({
          where: { id: cl.id, ...whereCoordinate({ ...t, channel: 'AMAZON' }) },
          data: { offerClosedAt: null, offerActive: true, offerClosedBy: null, offerCloseReason: null },
        })
        result.results.push({ productId: t.productId, sku, marketplace: t.marketplace, action: 'REOPENED', detail: undefined, fba: true, ...(fromNexus ? { fromNexus } : {}) })
        result.updated++
        processed++
        continue
      }

      // Reopening forces FOLLOW and queues quantity. Check the shared number
      // for this account/alias before either the patch or any local mutation.
      // S3 — per seller SKU: only the rows that sell under this SKU share its one EU quantity (a row whose SKU cannot be
      // told counts as sharing it). Rows with no SKU of their own all sell under the product SKU, as before.
      const siblingRows = await prisma.channelListing.findMany({
        where: { productId: t.productId, channel: 'AMAZON', channelConnectionId: t.channelConnectionId, aliasKey: t.aliasKey },
        include: { product: { select: { fulfillmentMethod: true, sku: true } }, offers: SELLER_SKU_SELECT.offers },
      })
      const euRows = siblingRows.filter(r => r.id === cl.id || sharesAmazonSellerSku(r, r.product?.sku, sku))
      const conflict = detectEuIntentConflict(euRows.map(r => ({
        marketplace: r.marketplace, quantity: r.quantity,
        followMasterQuantity: r.id === cl.id ? true : r.followMasterQuantity,
        quantityOverride: r.id === cl.id ? null : r.quantityOverride,
        syncPaused: r.id === cl.id ? false : r.syncPaused,
        isFba: isFbaCoordinate(r), offerClosed: r.id === cl.id ? false : !!r.offerClosedAt,
      })))
      if (conflict.conflict) throw new Error(`AMAZON_EU_QUANTITY_CONFLICT: ${conflict.detail}. ${EU_GUARD_REMEDY}`)

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

      if (res.dryRun) {
        result.results.push({ productId: t.productId, sku, marketplace: t.marketplace, action: 'DRY_RUN', detail: 'Preview only; offer state unchanged.' })
        result.unchanged++; processed++; continue
      }

      // Rejoin the pool only after the acknowledged patch and the EU guard.
      await prisma.channelListing.update({
        where: { id: cl.id, ...whereCoordinate({ ...t, channel: 'AMAZON' }) },
        data: {
          offerClosedAt: null,
          offerActive: true,
          offerClosedBy: null,
          offerCloseReason: null,
          // snapshot kept for audit/history — cheap and occasionally useful.
          followMasterQuantity: true,
          quantityOverride: null,
          lastSyncStatus: 'PENDING',
          lastSyncedAt: null,
        },
      })
      await createOutboundRow(prisma, {
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
      result.results.push({ productId: t.productId, sku, marketplace: t.marketplace, action: 'REOPENED', detail: undefined, ...(fromNexus ? { fromNexus } : {}) })
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

/** Conservative product/market refusal belt for legacy push callers. This may
 * refuse a sibling account; it is never an authorization predicate for a write. */
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
