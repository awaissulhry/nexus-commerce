import { getAmazonSellerId } from '../lib/amazon-sp-client.js'
import { workspaceKey } from '@nexus/database/workspace-context'
/**
 * G.5.1 — Outbound price dispatcher.
 *
 * Reads PricingSnapshot rows that need pushing (computedAt > last sync,
 * or fresh signals) and dispatches per-channel updates:
 *
 *   - Amazon: amazonSpApiClient.patchListingPrice (price-only PATCH); with
 *     NEXUS_AMAZON_OFFER_MERGE=1 a merge on the live offer (pushAmazonPriceAsMerge)
 *   - eBay:   ReviseInventoryStatus (skeleton; real wiring under
 *             ebay-publish.adapter.ts pattern)
 *   - Shopify / WooCommerce / Etsy: stub for now; same pattern when
 *     credentials land.
 *
 * Idempotent and respects the existing OutboundSyncQueue.holdUntil
 * 5-minute undo window. Each send writes ChannelListingOverride for
 * audit and updates ChannelListing.lastSyncStatus.
 *
 * NOT END-TO-END TESTED — Amazon path needs LWA + seller account
 * authorized for putListingsItem PATCH semantics; eBay needs the
 * ChannelConnection OAuth tokens. Without creds the path returns a
 * structured error per SKU (caller logs but doesn't crash).
 */

import type { PrismaClient } from '@prisma/client'
import { amazonSpApiClient } from '../clients/amazon-sp-api.client.js'
import { assertPushAllowed } from '@nexus/shared/push-lock'
import { closedMarketSet } from './amazon-market-offer.service.js'
import { getAmazonPublishMode } from './amazon-publish-gate.service.js'
import { amazonListingPriceOffer, amazonOfferMergeEnabled, amazonOfferReadFailure, amazonPriceOfferPlan, readAmazonOfferLive } from './amazon/purchasable-offer.js'
import { logger } from '../utils/logger.js'

export interface PushPriceArgs {
  sku: string
  channel: string
  marketplace: string
  fulfillmentMethod?: 'FBA' | 'FBM' | null
  channelConnectionId?: string | null
  aliasKey?: string | null
}

export interface PushPriceResult {
  ok: boolean
  sku: string
  channel: string
  marketplace: string
  pushedPrice: number | null
  currency: string | null
  error?: string
  refusal?: { code: string; sentence: string }
  /** P4.4d — true when the price was QUEUED for the one dispatcher rather than
   *  sent from here. Queued is not sent, and the answer says so. */
  queued?: boolean
  queueId?: string | null
  durationMs: number
}

/**
 * Push the latest PricingSnapshot for the given (sku, channel,
 * marketplace) to the channel's API.
 */
export async function pushPriceUpdate(
  prisma: PrismaClient,
  args: PushPriceArgs,
): Promise<PushPriceResult> {
  const startedAt = Date.now()
  const { sku, channel, marketplace } = {
    sku: args.sku,
    channel: args.channel.toUpperCase(),
    marketplace: args.marketplace.toUpperCase(),
  }
  const fm = args.fulfillmentMethod ?? null

  // Read the snapshot the engine wrote.
  const snapshot = await prisma.pricingSnapshot.findFirst({
    where: { sku, channel, marketplace, fulfillmentMethod: fm },
    orderBy: { computedAt: 'desc' },
  })
  if (!snapshot) {
    return {
      ok: false,
      sku,
      channel,
      marketplace,
      pushedPrice: null,
      currency: null,
      error: 'No pricing snapshot — run /pricing/refresh-snapshots first',
      durationMs: Date.now() - startedAt,
    }
  }

  if (channel === 'AMAZON') {
    return await pushAmazonPrice(prisma, sku, marketplace, snapshot, startedAt, args)
  }
  // P4.4d — eBay, Shopify, WooCommerce and Etsy reach their existing sender
  // through the one queue. Etsy was refused here while it was read-only (D6);
  // D6 was overridden 2026-09-21 and `syncToEtsy` sends a PRICE_UPDATE (P4.6e).
  if (channel === 'EBAY' || channel === 'SHOPIFY' || channel === 'WOOCOMMERCE' || channel === 'ETSY') {
    return await queuePriceUpdate(prisma, sku, channel, marketplace, snapshot, startedAt, args)
  }
  return {
    ok: false,
    sku,
    channel,
    marketplace,
    pushedPrice: Number(snapshot.computedPrice),
    currency: snapshot.currency,
    error: `${channel} is not a channel Nexus prices. Nothing was queued.`,
    durationMs: Date.now() - startedAt,
  }
}

async function pushAmazonPrice(
  prisma: PrismaClient,
  sku: string,
  marketplaceCode: string,
  snapshot: any,
  startedAt: number,
  coordinate: Pick<PushPriceArgs, 'channelConnectionId' | 'aliasKey'>,
): Promise<PushPriceResult> {
  const sellerId = (await getAmazonSellerId())
  if (!sellerId) {
    return {
      ok: false,
      sku,
      channel: 'AMAZON',
      marketplace: marketplaceCode,
      pushedPrice: Number(snapshot.computedPrice),
      currency: snapshot.currency,
      error: 'AMAZON_SELLER_ID env var not set',
      durationMs: Date.now() - startedAt,
    }
  }

  const marketplace = await prisma.marketplace.findUnique({
    where: { channel_code: workspaceKey({ channel: 'AMAZON', code: marketplaceCode }) },
  })
  if (!marketplace?.marketplaceId) {
    return {
      ok: false,
      sku,
      channel: 'AMAZON',
      marketplace: marketplaceCode,
      pushedPrice: Number(snapshot.computedPrice),
      currency: snapshot.currency,
      error: `Marketplace AMAZON:${marketplaceCode} not seeded with marketplaceId`,
      durationMs: Date.now() - startedAt,
    }
  }

  // Need productType for the SP-API patch envelope. Pulled from the
  // ChannelListing whose price we're updating.
  const listings = await prisma.channelListing.findMany({
    where: {
      channel: 'AMAZON',
      marketplace: marketplaceCode,
      product: { sku },
      ...(coordinate.channelConnectionId !== undefined ? { channelConnectionId: coordinate.channelConnectionId } : {}),
      ...(coordinate.aliasKey !== undefined ? { aliasKey: coordinate.aliasKey } : {}),
    },
    // Read all columns: syncPaused/offerClosedAt now, presenceIntent automatically
    // after Wave 2's applied migration and generated client; never read it from JSON.
    take: 2,
  })
  const listing = listings.length === 1 ? listings[0] : null
  if (!listing) return { ok: false, sku, channel: 'AMAZON', marketplace: marketplaceCode, pushedPrice: null,
    currency: snapshot.currency, durationMs: Date.now() - startedAt,
    error: listings.length ? 'Choose an exact account and alias before pushing this price.' : 'No listing exists for this seller SKU and market.' }
  const closed = await closedMarketSet([listing.productId])
  const refusal = assertPushAllowed(listing)
    ?? (closed.has(`${listing.productId}|${marketplaceCode}`) ? assertPushAllowed({ offerClosedAt: 'closed' }) : null)
  if (refusal) {
    await prisma.channelListing.update({ where: { id: listing.id }, data: {
      lastSyncStatus: 'SKIPPED', syncStatus: 'FAILED', lastSyncError: `${refusal.code}: ${refusal.sentence}`,
    } })
    return { ok: false, sku, channel: 'AMAZON', marketplace: marketplaceCode, pushedPrice: null,
      currency: snapshot.currency, durationMs: Date.now() - startedAt, error: refusal.sentence, refusal }
  }
  // platformAttributes JSON may carry productType; otherwise fall back to
  // a sensible default (LUGGAGE / OUTERWEAR depending on catalog). For v0,
  // require it — Xavia's listing wizard already sets it during publish.
  const platformAttrs = (listing?.platformAttributes ?? {}) as Record<string, unknown>
  const productType = (platformAttrs.productType as string) ?? null
  if (!productType) {
    return {
      ok: false,
      sku,
      channel: 'AMAZON',
      marketplace: marketplaceCode,
      pushedPrice: Number(snapshot.computedPrice),
      currency: snapshot.currency,
      error: 'productType missing on ChannelListing.platformAttributes — re-run wizard publish',
      durationMs: Date.now() - startedAt,
    }
  }

  const priceArgs = {
    sellerId,
    sku,
    marketplaceId: marketplace.marketplaceId,
    productType,
    price: Number(snapshot.computedPrice),
    currencyCode: snapshot.currency,
    taxInclusive: marketplace.taxInclusive ?? false,
  }
  // NEXUS_AMAZON_OFFER_MERGE (amazon/purchasable-offer.ts) — OFF by default, and OFF is exactly the replace this always
  // sent. ON, in live mode only (gated / dry-run / sandbox answer without HTTP inside patchListingPrice, as before), the
  // price goes as a merge on the live offer and the rest of Amazon's offer stays.
  const result: { success: boolean; error?: string; dryRun?: boolean } =
    amazonOfferMergeEnabled() && getAmazonPublishMode() === 'live'
      ? await pushAmazonPriceAsMerge(priceArgs)
      : await amazonSpApiClient.patchListingPrice(priceArgs)

  // Record the override + sync state.
  // PD.3 — a gated/dry-run patch publishes NOTHING; it must not write a green
  // SUCCESS/IN_SYNC state or a price-override row that reads as "pushed".
  const dryRun = (result as { dryRun?: boolean }).dryRun === true
  if (result.success && !dryRun && listing) {
    await prisma.channelListingOverride.create({
      data: {
        channelListingId: listing.id,
        fieldName: 'price',
        previousValue: null,
        newValue: snapshot.computedPrice.toString(),
        reason: `pricing-engine source=${snapshot.source}`,
        changedBy: 'pricing-outbound',
      },
    })
    await prisma.channelListing.update({
      where: { id: listing.id },
      data: {
        lastSyncedAt: new Date(),
        lastSyncStatus: 'SUCCESS',
        syncStatus: 'IN_SYNC',
        lastSyncError: null,
      },
    })
  } else if (dryRun && listing) {
    await prisma.channelListing.update({
      where: { id: listing.id },
      data: { lastSyncStatus: 'DRY_RUN', lastSyncError: null },
    })
  } else if (!result.success && listing) {
    await prisma.channelListing.update({
      where: { id: listing.id },
      data: {
        lastSyncStatus: 'FAILED',
        syncStatus: 'FAILED',
        lastSyncError: result.error ?? null,
      },
    })
  }

  return {
    ok: result.success,
    sku,
    channel: 'AMAZON',
    marketplace: marketplaceCode,
    pushedPrice: Number(snapshot.computedPrice),
    currency: snapshot.currency,
    error: result.success ? undefined : result.error,
    durationMs: Date.now() - startedAt,
  }
}

/**
 * The pricing-engine push with NEXUS_AMAZON_OFFER_MERGE on — the queue's reader and plan (amazon/purchasable-offer.ts),
 * not a copy. `patchListingPrice` replaces `purchasable_offer` with an instance that holds only `our_price`; this reads
 * the live offer and merges `our_price` into the instance it prices, so a Seller Central sale, map_price, the min/max
 * seller-allowed prices, the offer dates and the B2B instance stay. The engine never owns a sale (a scheduled sale
 * reaches it as the price itself), so it never sends `discounted_price`.
 *
 * A failed read sends nothing and fails like any failed push here — `ok: false`, the listing FAILED with the reason —
 * so pushing again retries. No live instance in the market: the replace, as before. An instance it cannot name: refused.
 */
async function pushAmazonPriceAsMerge(args: Parameters<typeof amazonSpApiClient.patchListingPrice>[0]): Promise<{ success: boolean; error?: string; dryRun?: boolean }> {
  const live = await readAmazonOfferLive({ sellerId: args.sellerId, sku: args.sku, marketplaceId: args.marketplaceId })
  if (live.read === 'failed') return { success: false, error: `${amazonOfferReadFailure(args.sku, live.error)} Push the price again to retry.` }
  const plan = amazonPriceOfferPlan({ built: amazonListingPriceOffer(args), live: live.instances, marketplaceId: args.marketplaceId, saleRemoved: false })
  if (plan.kind === 'refused') return { success: false, error: plan.reason }
  if (plan.kind === 'first-offer') return amazonSpApiClient.patchListingPrice(args)
  return amazonSpApiClient.patchPurchasableOffer({
    sellerId: args.sellerId, sku: args.sku, marketplaceId: args.marketplaceId, productType: args.productType, op: 'merge', value: plan.patch.value,
  })
}

/**
 * P4.4d — eBay (and every other channel this dispatcher does not send itself)
 * goes through the ONE outbound queue.
 *
 * 🔴 The plan row reads *"build the eBay price push (today a stub)"*, and the
 * obvious reading — write a `ReviseInventoryStatus` adapter here — is the wrong
 * build. **eBay price pushing already works.** `syncToEbay` puts a price on the
 * eBay OFFER endpoint (the price and the quantity live on different endpoints,
 * Phase 0.1), `ebay-variation-push` prices a variation group, and
 * `ebay-shared-listing-push` prices a shared ItemID. What was missing was not an
 * eBay sender; it was a way for THIS dispatcher to reach one.
 *
 * Writing a second sender here would also have to be exempted from P1.1's
 * ratchet, which holds channel sends outside the gateway at **0** — and the
 * reason that ratchet exists is exactly this: a second path that nobody
 * maintains, with its own idea of the currency, the push lock and the market.
 *
 * Enqueuing instead inherits, for free and in one place:
 *   - the push lock, the pause gates and the review verdict (dispatchSync);
 *   - the market's currency from `Marketplace.currency` (P4.4a);
 *   - the operator's pricing floor and ceiling (P4.4c);
 *   - the destination account rule (P1.3) and the call ledger (P1.2);
 *   - and the row NAMES its listing (P4.4b), so all of the above can apply.
 *
 * The answer is honest about what it did: `ok: true` with `queued: true`. It is
 * queued, not sent, and the undo window is the queue's own.
 */
async function queuePriceUpdate(
  prisma: PrismaClient,
  sku: string,
  channel: string,
  marketplaceCode: string,
  snapshot: any,
  startedAt: number,
  coordinate: Pick<PushPriceArgs, 'channelConnectionId' | 'aliasKey'>,
): Promise<PushPriceResult> {
  const fail = (error: string): PushPriceResult => ({
    ok: false, sku, channel, marketplace: marketplaceCode,
    pushedPrice: Number(snapshot.computedPrice), currency: snapshot.currency,
    error, durationMs: Date.now() - startedAt,
  })

  const listings = await prisma.channelListing.findMany({
    where: {
      channel,
      marketplace: marketplaceCode,
      product: { sku },
      ...(coordinate.channelConnectionId ? { channelConnectionId: coordinate.channelConnectionId } : {}),
      ...(coordinate.aliasKey !== undefined && coordinate.aliasKey !== null ? { aliasKey: coordinate.aliasKey } : {}),
    },
    select: { id: true, productId: true, channelConnectionId: true, region: true, externalListingId: true },
  })
  // Never resolve a coordinate the caller did not name (MAP.3): two listings
  // mean two accounts or two aliases, and picking one is a guess.
  if (listings.length === 0) return fail(`No ${channel} ${marketplaceCode} listing for ${sku}. Publish or link it first.`)
  if (listings.length > 1) {
    return fail(`More than one ${channel} ${marketplaceCode} listing holds ${sku}. Name the account or the alias; none was chosen automatically.`)
  }
  const listing = listings[0]

  const refusal = assertPushAllowed(listing as never)
  if (refusal) {
    return { ...fail(refusal.sentence), refusal: { code: refusal.code, sentence: refusal.sentence } }
  }

  const { createOutboundRow } = await import('./outbound-rows.js')
  const row = await createOutboundRow(prisma as never, {
    data: {
      productId: listing.productId,
      channelListingId: listing.id,
      channelConnectionId: listing.channelConnectionId,
      targetChannel: channel as never,
      targetRegion: listing.region,
      syncStatus: 'PENDING',
      syncType: 'PRICE_UPDATE',
      externalListingId: listing.externalListingId,
      maxRetries: 3,
      payload: {
        source: 'PRICING_SNAPSHOT_PUSH',
        productId: listing.productId,
        price: Number(snapshot.computedPrice),
        marketplace: marketplaceCode,
      },
    } as never,
    select: { id: true },
  })
  logger.info('pricing-outbound: price queued for the one dispatcher', {
    sku, channel, marketplace: marketplaceCode, listingId: listing.id, queueId: row?.id,
  })
  return {
    ok: true,
    sku,
    channel,
    marketplace: marketplaceCode,
    pushedPrice: Number(snapshot.computedPrice),
    currency: snapshot.currency,
    queued: true,
    queueId: row?.id ?? null,
    durationMs: Date.now() - startedAt,
  }
}
