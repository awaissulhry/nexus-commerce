/**
 * G.5.1 — `/pricing`'s "Push price" (`POST /api/pricing/push`).
 *
 * 2026-10-01 — every channel goes through the ONE channel price door's SEND mode and the one outbound dispatcher;
 * nothing is sent from here (see `pushPriceUpdate`). The direct Amazon send this file held (`patchListingPrice`, the
 * merge on the live offer) is the dispatcher's own (`syncToAmazon`, `amazon/purchasable-offer.ts`).
 */

import type { PrismaClient } from '@prisma/client'
import { assertPushAllowed } from '@nexus/shared/push-lock'
import { closedMarketSet } from './amazon-market-offer.service.js'
import { writeChannelPrices } from './pim/channel-price-write.service.js'
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

/** The channels Nexus prices: the door queues them, and the one dispatcher sends them. */
const PRICED_CHANNELS = new Set(['AMAZON', 'EBAY', 'SHOPIFY', 'WOOCOMMERCE', 'ETSY'])

/**
 * Push the price a listing carries to its channel — `/pricing`'s "Push price" (2026-10-01: through the ONE channel
 * price door).
 *
 * 🔴 Before, Amazon was sent the snapshot's number DIRECTLY from here (`patchListingPrice`, or a merge on the live
 * offer), outside the outbound queue, with its own audit and an IN_SYNC it wrote itself; eBay, Shopify, WooCommerce and
 * Etsy got a queue row of this service's own, with no hold, no cancel of a waiting row and no audit. The number was
 * the pricing engine's, which disagreed with the price the listing carries (FX, VAT, its own floor).
 *
 * Now every channel goes the same way: the door's SEND mode (`resend`, named reason `pricing-push`) sends the price the
 * listing carries — a following listing's rule price (recomputed and stored if it moved), a pinned listing's own — as ONE
 * PRICE_UPDATE row on the 30 s hold, cancelling a waiting one, through the one dispatcher (push lock, currency, the
 * merge on the live Amazon offer, the floor and ceiling, the account). A paused listing or a draft, a price of 0 or one
 * outside the floor/ceiling (master currency) is refused by name. The answer is honest: `queued`, not sent.
 */
export async function pushPriceUpdate(
  prisma: PrismaClient,
  args: PushPriceArgs,
): Promise<PushPriceResult> {
  const startedAt = Date.now()
  const sku = args.sku
  const channel = args.channel.toUpperCase()
  const marketplace = args.marketplace.toUpperCase()
  // The engine's currency for the answer only; the door decides the price.
  const snapshot = await prisma.pricingSnapshot.findFirst({
    where: { sku, channel, marketplace, fulfillmentMethod: args.fulfillmentMethod ?? null },
    orderBy: { computedAt: 'desc' },
    select: { currency: true },
  })
  const currency = snapshot?.currency ?? null
  const fail = (error: string, refusal?: { code: string; sentence: string }): PushPriceResult => ({
    ok: false, sku, channel, marketplace, pushedPrice: null, currency, error, ...(refusal ? { refusal } : {}), durationMs: Date.now() - startedAt,
  })
  if (!PRICED_CHANNELS.has(channel)) return fail(`${channel} is not a channel Nexus prices. Nothing was queued.`)

  const listings = await prisma.channelListing.findMany({
    where: {
      channel,
      marketplace,
      product: { sku },
      ...(args.channelConnectionId !== undefined ? { channelConnectionId: args.channelConnectionId } : {}),
      ...(args.aliasKey !== undefined && args.aliasKey !== null ? { aliasKey: args.aliasKey } : {}),
    },
    // Read all columns: syncPaused/offerClosedAt now, presenceIntent automatically after Wave 2's applied migration.
    take: 2,
  })
  // Never resolve a coordinate the caller did not name (MAP.3): two listings mean two accounts or two aliases.
  if (listings.length === 0) return fail(`No ${channel} ${marketplace} listing for ${sku}. Publish or link it first.`)
  if (listings.length > 1) return fail(`More than one ${channel} ${marketplace} listing holds ${sku}. Name the account or the alias; none was chosen automatically.`)
  const listing = listings[0]

  // The push lock answers first, with its own sentence (the dispatcher would refuse the row on the same ground).
  const closed = channel === 'AMAZON' ? await closedMarketSet([listing.productId]) : new Set<string>()
  const lock = assertPushAllowed(listing as never)
    ?? (closed.has(`${listing.productId}|${marketplace}`) ? assertPushAllowed({ offerClosedAt: 'closed' }) : null)
  if (lock) return fail(lock.sentence, { code: lock.code, sentence: lock.sentence })

  const written = await writeChannelPrices({
    targets: [{ listingId: listing.id, resend: true, unguardedReason: 'pricing-push' }],
    actor: 'pricing-push', source: 'MANUAL_OVERRIDE', reason: 'Push price (/pricing)',
  })
  const outcome = written.results[0]
  if (!outcome || outcome.outcome !== 'applied') return fail(outcome?.reason ?? 'The price write refused this listing. Nothing was queued.')
  logger.info('pricing-outbound: price queued through the channel price door', { sku, channel, marketplace, listingId: listing.id, queueId: outcome.queueId })
  return {
    ok: true, sku, channel, marketplace,
    pushedPrice: outcome.sentPrice ?? null,
    currency,
    queued: true,
    queueId: outcome.queueId,
    durationMs: Date.now() - startedAt,
  }
}
