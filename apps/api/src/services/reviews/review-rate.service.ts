/**
 * Reviews — the ONE review rate (Owner, 2026-10-27; audit C2, B2). Every page that shows "Review rate" counts it here:
 * the Overview's tile and channel table, the Requests page's tile and "What requests brought", each rule's Rate, the
 * Amazon and eBay pages and the Timing page.
 *
 *   rate = requests SENT in the period that a visible review followed ÷ the requests sent where a review CAN follow.
 *
 * "Followed" is the link the attribution job writes (review-attribution.service.ts → Review.attributedRequestId): a
 * review that names its order (eBay feedback, Amazon seller feedback) is linked to that order's request; a product
 * review without an order to a request for the same product, channel and market sent within 30 days before it.
 *
 * "Can follow" (measurable): eBay — some eBay feedback in Nexus is linked to its order (eBay feedback names no product,
 * so without the order nothing can be matched); every other channel — reviews of that channel and market arrive in
 * Nexus (Amazon gives no review count: only reviews a person imported or seller feedback). Where nothing can follow,
 * the rate is null and the words say so — never a 0 %.
 *
 * `rateOf` and its words are pure (review-rate.vitest.test.ts); `readRateRequests` / `readRateFacts` read.
 */
import type { Prisma } from '@prisma/client'
import prisma from '../../db.js'
import { visibleReviewWhere } from './review-visibility.js'

/** A review counts for a request when it arrives within this many days after the request. */
export const ATTRIBUTION_DAYS = 30

export interface RateRequest {
  id: string
  channel: string
  marketplace: string | null
  sentAt: Date | null
  ruleId: string | null
  productType: string | null
  /** A visible review is linked to it. */
  followed: boolean
}

/** Where a review can follow a request (read once per answer). */
export interface RateFacts {
  /** `CHANNEL|MARKET` of every channel × market some visible review came from. */
  reviewedKeys: ReadonlySet<string>
  /** Some eBay feedback in Nexus is linked to its order. */
  ebayLinked: boolean
}

export interface RateResult {
  sent: number
  /** Sent where a review can follow. */
  measured: number
  followed: number
  /** 0…1; null when nothing measurable was sent. */
  rate: number | null
  /** Why the rate leaves requests out, or why there is none, in words; null when every sent request counts. */
  words: string | null
}

export const rateKey = (channel: string, market: string | null | undefined) => `${channel.toUpperCase()}|${(market ?? '').toUpperCase()}`

/** Can a review follow a request of this channel and market? Pure. */
export function rateMeasurable(channel: string, market: string | null | undefined, facts: RateFacts): boolean {
  if (channel.toUpperCase() === 'EBAY') return facts.ebayLinked
  return facts.reviewedKeys.has(rateKey(channel, market))
}

/** Why nothing sent can be measured, in words. Pure. */
export function notMeasurableWords(rows: ReadonlyArray<Pick<RateRequest, 'channel'>>): string {
  const channels = new Set(rows.map((r) => r.channel.toUpperCase()))
  if (channels.size === 1 && channels.has('EBAY')) {
    return 'Not measurable: no eBay feedback in Nexus is linked to its order yet, so none can be matched to a request.'
  }
  if (channels.size === 1 && channels.has('AMAZON')) {
    return 'Not measurable: Amazon gives no review count — import this market’s reviews to estimate it.'
  }
  if (channels.size === 1 && channels.has('SHOPIFY')) {
    return 'Not measurable: no Shopify review is in Nexus yet — Shopify keeps none itself; connect the store’s review app to count them.'
  }
  return 'Not measurable: no review that could follow these requests is in Nexus yet.'
}

/** The rate of these sent requests. Pure. */
export function rateOf(rows: ReadonlyArray<Pick<RateRequest, 'channel' | 'marketplace' | 'followed'>>, facts: RateFacts): RateResult {
  const sent = rows.length
  const measuredRows = rows.filter((r) => rateMeasurable(r.channel, r.marketplace, facts))
  const followed = measuredRows.filter((r) => r.followed).length
  const measured = measuredRows.length
  const rate = measured > 0 ? Math.min(1, followed / measured) : null
  let words: string | null = null
  if (sent > 0 && measured === 0) words = notMeasurableWords(rows)
  else if (measured < sent) words = `${(sent - measured).toLocaleString('en')} of ${sent.toLocaleString('en')} sent where no review can be matched yet — left out of the rate.`
  return { sent, measured, followed, rate, words }
}

/** Percent with one decimal, or null. */
export function ratePercent(r: RateResult): number | null {
  return r.rate == null ? null : Math.round(r.rate * 1000) / 10
}

/** The requests SENT in [from, to] (from null = all time), in scope, each with whether a visible review followed it. */
export async function readRateRequests(scope: {
  from: Date | null
  to: Date
  channel?: string | null
  market?: string | null
  ruleId?: string | null
}): Promise<RateRequest[]> {
  const where: Prisma.ReviewRequestWhereInput = {
    status: 'SENT',
    sentAt: { ...(scope.from ? { gte: scope.from } : {}), lte: scope.to },
    ...(scope.channel ? { channel: scope.channel } : {}),
    ...(scope.market ? { marketplace: scope.market } : {}),
    ...(scope.ruleId ? { ruleId: scope.ruleId } : {}),
  }
  const rows = await prisma.reviewRequest.findMany({
    where,
    select: {
      id: true, channel: true, marketplace: true, sentAt: true, ruleId: true,
      order: { select: { items: { take: 1, select: { product: { select: { productType: true } } } } } },
      _count: { select: { attributedReviews: { where: visibleReviewWhere() } } },
    },
    take: 100_000,
  })
  return rows.map((r) => ({
    id: r.id,
    channel: r.channel,
    marketplace: r.marketplace,
    sentAt: r.sentAt,
    ruleId: r.ruleId,
    productType: r.order?.items[0]?.product?.productType ?? null,
    followed: r._count.attributedReviews > 0,
  }))
}

/** Where a review can follow a request: the channel × markets visible reviews came from, and eBay's order links. */
export async function readRateFacts(): Promise<RateFacts> {
  const [groups, linkedEbay] = await Promise.all([
    prisma.review.groupBy({ by: ['channel', 'marketplace'], where: visibleReviewWhere() }),
    prisma.review.findFirst({ where: visibleReviewWhere({ channel: 'EBAY', orderId: { not: null } }), select: { id: true } }),
  ])
  return { reviewedKeys: new Set(groups.map((g) => rateKey(g.channel, g.marketplace))), ebayLinked: !!linkedEbay }
}
