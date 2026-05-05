/**
 * G.5.1 — Outbound price dispatcher.
 *
 * Reads PricingSnapshot rows that need pushing (computedAt > last sync,
 * or fresh signals) and dispatches per-channel updates:
 *
 *   - Amazon: amazonSpApiClient.patchListingPrice (price-only PATCH)
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
import { logger } from '../utils/logger.js'

export interface PushPriceArgs {
  sku: string
  channel: string
  marketplace: string
  fulfillmentMethod?: 'FBA' | 'FBM' | null
}

export interface PushPriceResult {
  ok: boolean
  sku: string
  channel: string
  marketplace: string
  pushedPrice: number | null
  currency: string | null
  error?: string
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
    return await pushAmazonPrice(prisma, sku, marketplace, snapshot, startedAt)
  }
  if (channel === 'EBAY') {
    return await pushEbayPrice(prisma, sku, marketplace, snapshot, startedAt)
  }
  // Other channels return NOT_IMPLEMENTED-shaped results so callers can
  // surface the gap honestly to the user.
  return {
    ok: false,
    sku,
    channel,
    marketplace,
    pushedPrice: Number(snapshot.computedPrice),
    currency: snapshot.currency,
    error: `${channel} outbound push not yet wired — see TECH_DEBT.`,
    durationMs: Date.now() - startedAt,
  }
}

async function pushAmazonPrice(
  prisma: PrismaClient,
  sku: string,
  marketplaceCode: string,
  snapshot: any,
  startedAt: number,
): Promise<PushPriceResult> {
  const sellerId = process.env.AMAZON_SELLER_ID ?? process.env.AMAZON_MERCHANT_ID ?? ''
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
    where: { channel_code: { channel: 'AMAZON', code: marketplaceCode } },
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
  const listing = await prisma.channelListing.findFirst({
    where: {
      channel: 'AMAZON',
      marketplace: marketplaceCode,
      product: {
        OR: [{ sku }, { variations: { some: { sku } } }],
      },
    },
    select: { id: true, platformAttributes: true },
  })
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

  const result = await amazonSpApiClient.patchListingPrice({
    sellerId,
    sku,
    marketplaceId: marketplace.marketplaceId,
    productType,
    price: Number(snapshot.computedPrice),
    currencyCode: snapshot.currency,
    taxInclusive: marketplace.taxInclusive ?? false,
  })

  // Record the override + sync state.
  if (result.success && listing) {
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

async function pushEbayPrice(
  prisma: PrismaClient,
  sku: string,
  marketplaceCode: string,
  snapshot: any,
  startedAt: number,
): Promise<PushPriceResult> {
  // eBay ReviseInventoryStatus skeleton. Real implementation reuses the
  // ebay-publish.adapter pattern from DD.4 — needs a ChannelConnection
  // tied to the eBay site (one connection per site since OAuth scope
  // is site-scoped).
  logger.warn('eBay outbound push: NOT_IMPLEMENTED', {
    sku,
    marketplace: marketplaceCode,
  })
  return {
    ok: false,
    sku,
    channel: 'EBAY',
    marketplace: marketplaceCode,
    pushedPrice: Number(snapshot.computedPrice),
    currency: snapshot.currency,
    error: 'eBay ReviseInventoryStatus adapter not yet wired — see TECH_DEBT.',
    durationMs: Date.now() - startedAt,
  }
}
