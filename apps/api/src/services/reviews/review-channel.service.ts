/**
 * Reviews › channel pages (2026-10-26, build spec §3.5 / B18) — GET /api/reviews/area/channel?channel=AMAZON|EBAY&market=&period=
 * (routes/reviews-area.routes.ts): one channel, all its markets or one, in sections that fail ALONE — each is
 * `{ ok: true, data }` or `{ ok: false, error }` (words), the Overview's envelope, so a failed read shows only in its card.
 * GET /api/reviews/area/channel-markets lists the markets each channel page exists for (the sub-sidebar's rows).
 *
 * Amazon (ruling 5): no API gives Amazon's star rating, average or review count, so every star here comes from reviews a
 * person IMPORTED (`ingestSource = IMPORT_CSV`); topics come from the Customer Feedback API (AmazonReviewInsight: weekly,
 * English, UK/DE/FR/IT/ES only, never Amazon.nl, needs the Selling Partner Insights role); requests are ReviewRequest rows
 * by Amazon's answer (review-queue-words.ts). Seller feedback (PR H): Amazon's 1–3 star feedback report, fetched by
 * Nexus (amazon-seller-feedback.service.ts), rows with `kind = 'SELLER'`, each with the removal check
 * (review-feedback-removal.ts) — counted and listed, never averaged into the stars.
 *
 * eBay: the score, % positive, counts by type and the four detailed seller ratings are eBay's own (Trading GetFeedback,
 * at most once an hour per account: ebay-feedback-summary.service.ts); the list is the Inbox's seller-feedback rows
 * (review-inbox.service.ts), so a row opens the same review pop-up; read state per market from review-sources.service.ts.
 * PR G (eBay REST): eBay's AI topics and the revision requests (ebay-feedback-extras.service.ts) are two more sections;
 * leaving feedback for buyers has its own read and send (ebay-buyer-feedback.service.ts), and its queue's counts are the
 * "Buyers to rate" tile.
 *
 * Every Review read goes through `visibleReviewWhere` (fixtures never count). The arithmetic is pure, in
 * review-channel-math.ts and overviewMath.ts.
 */
import type { Prisma } from '@prisma/client'
import prisma from '../../db.js'
import { logger } from '../../utils/logger.js'
import { needsReplyWhere, reviewKindWhere, visibleReviewWhere } from './review-visibility.js'
import { readSellerFeedbackState, sellerFeedbackOn, type SellerFeedbackState } from './amazon-seller-feedback.service.js'
import { feedbackRemovalCheck, fulfilmentOf, REMOVAL_RULES, type RemovalCheck } from './review-feedback-removal.js'
import { FEEDBACK_WINDOW_DAYS } from './amazon-seller-feedback-report.js'
import { reviewSources } from './review-sources.service.js'
import { amazonThemes, scopeCode, type OverviewTheme, type Section } from './review-overview.service.js'
import { listInbox, type InboxRow } from './review-inbox.service.js'
import { reasonKeyOf } from './review-queue-words.js'
import { ratingOf } from './review-rating.js'
import { rateOf as oneRate, ratePercent, readRateFacts, readRateRequests } from './review-rate.service.js'
import { readEbayFeedbackSummary, type SummaryRead } from './ebay-feedback-summary.service.js'
import { ebayRevisionsSection, ebayTopicsSection, type EbayRevisions, type EbayTopics } from './ebay-feedback-extras.service.js'
import { buyersToRate, type BuyersToRate } from './ebay-buyer-feedback.service.js'
import { combineSummaries, positivePercent, yearPeriod, type EbayDetailedRating, type EbayFeedbackPeriod } from './adapters/ebay-feedback-summary.js'
import {
  averageRating, bucketKeys, channelMarketLabel, daysBetween, marketWords, periodBounds, periodOf, round,
  starCounts, trendPoints, type PeriodBounds, type TrendBucket, type TrendPoint,
} from './overviewMath.js'
import {
  amazonBucket, amazonRequestCounts, feedbackTypeCounts, IMPORTED_SOURCE, orderMarkets, pageAccounts, parseChannel,
  parseChannelPeriod, parseMarket, rankAmazonWatch, TOPIC_MARKETS, topicsState, topicsWords, TOPICS_WHERE_WORDS, type AmazonRequestCounts,
  type ChannelPeriod, type FeedbackTypeCounts, type ReviewChannel, type TopicsState,
} from './review-channel-math.js'

export class ChannelInputError extends Error {}

export interface ChannelMarket {
  code: string
  label: string
}

// ── Amazon sections ──────────────────────────────────────────────────

export interface AmazonTiles {
  /** Average stars of the reviews imported for the period; null when none was imported. */
  importedRating: number | null
  importedInPeriod: number
  /** Every imported review of this scope, any date. */
  importedTotal: number
  /** When the newest file was imported (ISO). */
  lastImportAt: string | null
  /** Amazon's "dislike" topics; null when there are no topics for this scope. */
  topicsToFix: number | null
  topicsWeekOf: string | null
  needReply: number
  oldestWaitDays: number | null
  requestsSent: number
  /** Percent, one decimal; null when nothing can be matched (the one rate, review-rate.service.ts). */
  reviewRate: number | null
  /** "Not measurable: …" when no review can follow these requests; null otherwise. */
  rateWords: string | null
  /** Amazon seller feedback (1–3 stars) left in the last 90 days, and in the 90 days before. */
  sellerFeedback90: number
  sellerFeedbackPrev90: number
  /** Whether Nexus fetches Amazon's seller feedback report in this setup. */
  sellerFeedbackOn: boolean
}

export interface AmazonTopic extends OverviewTheme {
  /** Amazon's 6-month trend of the topic — not read by Nexus yet (null). */
  trend: null
}

export interface AmazonTopics {
  state: TopicsState
  /** Why topics do not show, in words; null when they do. */
  words: string | null
  /** Where Amazon gives topics at all (always shown under the card). */
  where: string
  weekOf: string | null
  /** Products with topics in this scope. */
  productCount: number
  like: AmazonTopic[]
  dislike: AmazonTopic[]
  /** One entry per product with topics, for the card's product picker. */
  products: Array<{ key: string; name: string; like: AmazonTopic[]; dislike: AmazonTopic[] }>
}

export interface AmazonRequests extends AmazonRequestCounts {
  /** Percent, one decimal; null when no review can be matched here (the one rate). */
  reviewRate: number | null
  rateWords: string | null
}

export interface AmazonWatchRow {
  productId: string
  name: string
  sku: string | null
  ratingNow: number | null
  ratingBefore: number | null
  change: number | null
  imported: number
  topTopic: string | null
  /** Percent of the product's reviews that mention it (Amazon's topic); null when unknown. */
  topShare: number | null
  topMentions: number | null
}

export interface AmazonSellerFeedbackRow {
  id: string
  rating: number | null
  postedAt: string
  text: string
  english: string | null
  language: string | null
  /** Amazon's order id, from the report. */
  amazonOrderId: string | null
  /** The Nexus order, when Nexus has it. */
  orderId: string | null
  /** "Amazon shipped it (FBA)", "you shipped it", or null when unknown. */
  fulfilmentWords: string | null
  status: string
  /** A reply was seen in Amazon's report, or a person marked it as responded. */
  replied: boolean
  check: RemovalCheck
}

export interface AmazonSellerFeedback {
  fetch: SellerFeedbackState
  /** Feedback left in the last 90 days, in this scope. */
  total90: number
  /** The newest feedback (at most 20). */
  rows: AmazonSellerFeedbackRow[]
  /** The removal check's rules, in words. */
  rules: readonly string[]
}

export interface AmazonSections {
  tiles: Section<AmazonTiles>
  sellerFeedback: Section<AmazonSellerFeedback>
  trend: Section<{ bucket: TrendBucket; points: TrendPoint[] }>
  spread: Section<{ counts: [number, number, number, number, number]; average: number | null; rated: number; lastImportAt: string | null }>
  topics: Section<AmazonTopics>
  requests: Section<AmazonRequests>
  watch: Section<AmazonWatchRow[]>
}

// ── eBay sections ────────────────────────────────────────────────────

export interface EbayReadState {
  channel: 'EBAY'
  market: string | null
  label: string
  ok: boolean
  reason: string | null
  since: string | null
  reconnectHref: string | null
}

export interface EbayTiles extends FeedbackTypeCounts {
  /** eBay's feedback score (the account's); null when eBay was not read. */
  score: number | null
  /** % positive; eBay's 12-month figure when eBay was read, else from the feedback Nexus holds for the period. */
  positivePct: number | null
  positiveFrom: 'ebay' | 'nexus'
  needReply: number
  oldestWaitDays: number | null
  /** PR G — the "Leave feedback for buyers" queue's counts; null when it could not be read. */
  buyersToRate: BuyersToRate | null
}

export interface EbaySummary {
  /** read = eBay answered for every account; partial = for some; not_read = for none; no_account = nothing connected. */
  state: 'read' | 'partial' | 'not_read' | 'no_account'
  words: string | null
  /** The oldest answer shown (ISO): eBay is asked at most once an hour per account. */
  readAt: string | null
  /** A market page whose account sells on every eBay site: the numbers are the whole account's. */
  accountWide: boolean
  accounts: number
  score: number | null
  periods: EbayFeedbackPeriod[]
  dsr: EbayDetailedRating[]
  dsrPeriod: 'FiftyTwoWeeks' | 'ThirtyDays' | null
}

export interface EbayFeedbackList {
  rows: InboxRow[]
  /** Every row the scope holds; `rows` is the newest 200. */
  total: number
  owners: string[]
}

export interface EbaySections {
  readState: Section<EbayReadState[]>
  tiles: Section<EbayTiles>
  summary: Section<EbaySummary>
  feedback: Section<EbayFeedbackList>
  /** PR G — eBay's AI topics of the feedback in scope and period. */
  topics: Section<EbayTopics>
  /** PR G — revision requests (eBay's state of each feedback) and eBay's yearly allowance. */
  revisions: Section<EbayRevisions>
}

export interface ChannelPage {
  channel: ReviewChannel
  market: string | null
  label: string
  period: { key: ChannelPeriod; from: string | null; to: string; prevFrom: string | null; prevTo: string | null }
  generatedAt: string
  /** The markets of this channel that have a page (the market chips). */
  markets: ChannelMarket[]
  sections: AmazonSections | EbaySections
}

const SECTION_ERROR: Record<string, string> = {
  tiles: 'The numbers at the top could not be read.',
  trend: 'The rating chart could not be read.',
  spread: 'The rating spread could not be read.',
  topics: 'Amazon’s topics could not be read.',
  requests: 'The review requests could not be read.',
  watch: 'The products to watch could not be read.',
  sellerFeedback: 'The seller feedback could not be read.',
  readState: 'Nexus could not check whether eBay is read.',
  summary: 'eBay’s feedback summary could not be read.',
  feedback: 'The feedback could not be read.',
  ebayTopics: 'eBay’s topics could not be read.',
  revisions: 'The revision requests could not be read.',
}

async function section<T>(name: string, run: () => Promise<T>): Promise<Section<T>> {
  try {
    return { ok: true, data: await run() }
  } catch (err) {
    logger.warn('[reviews-channel] section failed', { section: name, error: err instanceof Error ? err.message : String(err) })
    return { ok: false, error: `${SECTION_ERROR[name] ?? 'This part could not be read.'} Try again in a moment.` }
  }
}

function once<T>(run: () => Promise<T>): () => Promise<T> {
  let p: Promise<T> | null = null
  return () => (p ??= run())
}

const iso = (d: Date | null | undefined) => d?.toISOString() ?? null

export interface ChannelInput {
  channel?: unknown
  market?: unknown
  period?: unknown
  now?: Date
}

/** GET /api/reviews/area/channel. A channel other than Amazon or eBay, or a market that is not two letters, is refused. */
export async function reviewsChannel(input: ChannelInput): Promise<ChannelPage> {
  const channel = parseChannel(input.channel)
  if (!channel) throw new ChannelInputError('This page is for Amazon or eBay. Shopify and Etsy pages come later.')
  const rawMarket = scopeCode(input.market)
  const market = rawMarket ? parseMarket(rawMarket) : null
  if (rawMarket && !market) throw new ChannelInputError('A market is two letters, such as IT or DE.')
  const now = input.now ?? new Date()
  const period = parseChannelPeriod(input.period)
  const bounds = periodBounds(period, now)

  const [markets, sections] = await Promise.all([
    channelMarkets(channel).catch((err) => {
      logger.warn('[reviews-channel] markets failed', { error: err instanceof Error ? err.message : String(err) })
      return [] as ChannelMarket[]
    }),
    channel === 'AMAZON' ? amazonSections(market, period, bounds, now) : ebaySections(market, period, bounds, now),
  ])

  return {
    channel,
    market,
    label: channelMarketLabel(channel, market),
    period: { key: period, from: iso(bounds.from), to: bounds.to.toISOString(), prevFrom: iso(bounds.prevFrom), prevTo: iso(bounds.prevTo) },
    generatedAt: now.toISOString(),
    markets,
    sections,
  }
}

// ── Amazon ───────────────────────────────────────────────────────────

type AmazonRow = { id: string; rating: number | null; postedAt: Date; productId: string | null }
type InsightRow = { asin: string; marketplace: string; productId: string | null; reviewCount: number | null; positiveTopics: unknown; negativeTopics: unknown; accessStatus: string; fetchedAt: Date }

function asTopics(list: OverviewTheme[]): AmazonTopic[] {
  return list.sort((a, b) => b.mentions - a.mentions || a.label.localeCompare(b.label)).map(t => ({ ...t, trend: null }))
}

async function amazonSections(market: string | null, period: ChannelPeriod, bounds: PeriodBounds, now: Date): Promise<AmazonSections> {
  const scope: Prisma.ReviewWhereInput = { channel: 'AMAZON', ...(market ? { marketplace: market } : {}) }
  // The ONE rating's Amazon rows (review-rating.ts): product reviews a person imported.
  const imported: Prisma.ReviewWhereInput = { AND: [{ ...scope, ingestSource: IMPORTED_SOURCE }, reviewKindWhere('product')] }
  const readFrom = bounds.prevFrom ?? bounds.from

  const rows = once(async (): Promise<AmazonRow[]> => prisma.review.findMany({
    where: visibleReviewWhere({ AND: [imported, { postedAt: { ...(readFrom ? { gte: readFrom } : {}), lte: bounds.to } }] }),
    select: { id: true, rating: true, postedAt: true, productId: true },
    orderBy: { postedAt: 'desc' },
    take: 50_000,
  }))
  const split = once(async () => {
    const all = await rows()
    return { now: all.filter(r => periodOf(r.postedAt, bounds) === 'now'), prev: all.filter(r => periodOf(r.postedAt, bounds) === 'prev') }
  })
  const importFacts = once(async () => {
    const agg = await prisma.review.aggregate({ where: visibleReviewWhere(imported), _count: { _all: true }, _max: { ingestedAt: true } })
    return { total: agg._count._all, lastImportAt: agg._max.ingestedAt ?? null }
  })
  const insights = once(async (): Promise<InsightRow[]> => prisma.amazonReviewInsight.findMany({
    where: market ? { marketplace: market } : {},
    select: { asin: true, marketplace: true, productId: true, reviewCount: true, positiveTopics: true, negativeTopics: true, accessStatus: true, fetchedAt: true },
    take: 2_000,
  }))
  const topicFacts = once(async () => {
    const all = await insights()
    // Amazon.nl and markets outside the five give no topics: their rows (if any) never count.
    const usable = all.filter(r => market || TOPIC_MARKETS.has(r.marketplace.toUpperCase()))
    const state = topicsState(market, usable)
    return { state, ok: state.state === 'not_on_market' ? [] : usable.filter(r => r.accessStatus === 'OK') }
  })
  const requests = once(async () => prisma.reviewRequest.findMany({
    where: {
      channel: 'AMAZON',
      ...(market ? { marketplace: market } : {}),
      OR: [
        { status: 'SENT' as const, sentAt: { ...(bounds.from ? { gte: bounds.from } : {}), lte: bounds.to } },
        // Any other state: touched in the period (a "too early" retry moves it every day).
        ...(bounds.from ? [{ status: { not: 'SENT' as const }, updatedAt: { gte: bounds.from } }] : [{ status: { not: 'SENT' as const } }]),
      ],
    },
    select: {
      status: true, channel: true, marketplace: true, providerResponseCode: true, suppressedReason: true, errorMessage: true,
      scheduledFor: true, sentAt: true, nextRetryAt: true, attemptCount: true,
    },
    take: 20_000,
  }))
  // The ONE review rate (review-rate.service.ts): where no Amazon review of this market is in Nexus, "not measurable".
  const rateOf = once(async () => {
    const [sent, facts] = await Promise.all([readRateRequests({ from: bounds.from, to: bounds.to, channel: 'AMAZON', market }), readRateFacts()])
    const r = oneRate(sent, facts)
    return { rate: ratePercent(r), words: r.words }
  })

  // Amazon seller feedback (kind SELLER): counted per 90 days and listed; never in the imported stars above.
  const sellerScope: Prisma.ReviewWhereInput = { AND: [scope, reviewKindWhere('seller')] }
  const sellerCounts = once(async () => {
    const from = new Date(now.getTime() - FEEDBACK_WINDOW_DAYS * 86_400_000)
    const before = new Date(from.getTime() - FEEDBACK_WINDOW_DAYS * 86_400_000)
    const [last, prev] = await Promise.all([
      prisma.review.count({ where: visibleReviewWhere({ AND: [sellerScope, { postedAt: { gte: from, lte: now } }] }) }),
      prisma.review.count({ where: visibleReviewWhere({ AND: [sellerScope, { postedAt: { gte: before, lt: from } }] }) }),
    ])
    return { last, prev }
  })
  const sellerState = once(() => readSellerFeedbackState(now))

  const [tiles, trend, spread, topics, requestSection, watch, sellerFeedback] = await Promise.all([
    section('tiles', async (): Promise<AmazonTiles> => {
      const [{ now: rowsNow }, facts, topicsNow, needReply, oldest, reqs, rate, seller] = await Promise.all([
        split(),
        importFacts(),
        topicFacts(),
        prisma.review.count({ where: { AND: [needsReplyWhere(now), scope] } }),
        prisma.review.findFirst({ where: { AND: [needsReplyWhere(now), scope] }, orderBy: { postedAt: 'asc' }, select: { postedAt: true } }),
        requests(),
        rateOf(),
        sellerCounts(),
      ])
      const avg = ratingOf(rowsNow.map(r => ({ channel: 'AMAZON', kind: 'PRODUCT', ingestSource: IMPORTED_SOURCE, rating: r.rating }))).stars
      const dislikes = topicsNow.ok.length ? amazonThemes(topicsNow.ok, 'NEGATIVE').length : null
      return {
        importedRating: avg == null ? null : round(avg, 1),
        importedInPeriod: rowsNow.length,
        importedTotal: facts.total,
        lastImportAt: iso(facts.lastImportAt),
        topicsToFix: dislikes,
        topicsWeekOf: iso(topicsNow.state.weekOf),
        needReply,
        oldestWaitDays: oldest ? daysBetween(oldest.postedAt, now) : null,
        requestsSent: reqs.filter(r => r.status === 'SENT').length,
        reviewRate: rate.rate,
        rateWords: rate.words,
        sellerFeedback90: seller.last,
        sellerFeedbackPrev90: seller.prev,
        sellerFeedbackOn: sellerFeedbackOn(),
      }
    }),

    section('trend', async () => {
      const { now: rowsNow } = await split()
      const bucket = amazonBucket(period)
      const from = bounds.from ?? new Date(now.getTime() - 30 * 86_400_000)
      return { bucket, points: trendPoints(rowsNow, bucketKeys(from, bounds.to, bucket), bucket) }
    }),

    section('spread', async () => {
      const [{ now: rowsNow }, facts] = await Promise.all([split(), importFacts()])
      const ratings = rowsNow.map(r => r.rating)
      const avg = averageRating(ratings)
      const counts = starCounts(ratings)
      return { counts, average: avg == null ? null : round(avg, 1), rated: counts.reduce((n, c) => n + c, 0), lastImportAt: iso(facts.lastImportAt) }
    }),

    section('topics', async (): Promise<AmazonTopics> => {
      const { state, ok } = await topicFacts()
      const ids = [...new Set(ok.map(r => r.productId).filter((id): id is string => !!id))]
      const products = ids.length ? await prisma.product.findMany({ where: { id: { in: ids } }, select: { id: true, name: true, sku: true } }) : []
      const nameOf = new Map(products.map(p => [p.id, p.name || p.sku]))
      const byProduct = new Map<string, { name: string; rows: InsightRow[] }>()
      for (const r of ok) {
        const key = r.productId ?? `asin:${r.asin}`
        const slot = byProduct.get(key) ?? { name: (r.productId && nameOf.get(r.productId)) || `ASIN ${r.asin}`, rows: [] }
        slot.rows.push(r)
        byProduct.set(key, slot)
      }
      return {
        state: state.state,
        words: topicsWords(state.state, market, state.lastOkAt),
        where: TOPICS_WHERE_WORDS,
        weekOf: iso(state.weekOf),
        productCount: byProduct.size,
        like: asTopics(amazonThemes(ok, 'POSITIVE')),
        dislike: asTopics(amazonThemes(ok, 'NEGATIVE')),
        products: [...byProduct.entries()]
          .map(([key, p]) => ({ key, name: p.name, like: asTopics(amazonThemes(p.rows, 'POSITIVE')), dislike: asTopics(amazonThemes(p.rows, 'NEGATIVE')) }))
          .sort((a, b) => a.name.localeCompare(b.name)),
      }
    }),

    section('requests', async (): Promise<AmazonRequests> => {
      const [reqs, rate] = await Promise.all([requests(), rateOf()])
      return { ...amazonRequestCounts(reqs.map(r => reasonKeyOf(r, now))), reviewRate: rate.rate, rateWords: rate.words }
    }),

    section('watch', async (): Promise<AmazonWatchRow[]> => {
      const [{ now: rowsNow, prev: rowsPrev }, { ok }] = await Promise.all([split(), topicFacts()])
      const byProduct = new Map<string, { now: Array<number | null>; before: Array<number | null>; insight: InsightRow[] }>()
      const slot = (id: string) => {
        const s = byProduct.get(id) ?? { now: [], before: [], insight: [] }
        byProduct.set(id, s)
        return s
      }
      for (const r of rowsNow) if (r.productId) slot(r.productId).now.push(r.rating)
      for (const r of rowsPrev) if (r.productId) slot(r.productId).before.push(r.rating)
      for (const r of ok) if (r.productId) slot(r.productId).insight.push(r)
      const ranked = rankAmazonWatch([...byProduct.entries()].map(([productId, s]) => ({ productId, now: s.now, before: s.before, hasTopics: s.insight.length > 0 })))
      if (ranked.length === 0) return []
      const products = await prisma.product.findMany({ where: { id: { in: ranked.map(r => r.productId) } }, select: { id: true, name: true, sku: true } })
      const productOf = new Map(products.map(p => [p.id, p]))
      return ranked.map(r => {
        const top = amazonThemes(byProduct.get(r.productId)?.insight ?? [], 'NEGATIVE').sort((a, b) => b.mentions - a.mentions)[0] ?? null
        const product = productOf.get(r.productId)
        return {
          productId: r.productId,
          name: product?.name || product?.sku || 'Product',
          sku: product?.sku ?? null,
          ratingNow: r.ratingNow,
          ratingBefore: r.ratingBefore,
          change: r.change,
          imported: r.imported,
          topTopic: top?.label ?? null,
          topShare: top?.share ?? null,
          topMentions: top?.mentions ?? null,
        }
      })
    }),

    section('sellerFeedback', async (): Promise<AmazonSellerFeedback> => {
      const [state, counts, rows] = await Promise.all([
        sellerState(),
        sellerCounts(),
        prisma.review.findMany({
          where: visibleReviewWhere(sellerScope),
          orderBy: { postedAt: 'desc' },
          take: 20,
          select: {
            id: true, rating: true, postedAt: true, body: true, bodyEnglish: true, language: true, orderId: true, triageStatus: true,
            rawPayload: true, sentiment: { select: { categories: true } },
            _count: { select: { responses: { where: { status: 'SENT' } } } },
          },
        }),
      ])
      const orderIds = [...new Set(rows.map(r => r.orderId).filter((id): id is string => !!id))]
      const orders = orderIds.length
        ? await prisma.order.findMany({ where: { id: { in: orderIds } }, select: { id: true, fulfillmentMethod: true } })
        : []
      const fulfilmentOfOrder = new Map(orders.map(o => [o.id, fulfilmentOf(o.fulfillmentMethod)]))
      const marketStates = market ? state.markets.filter(m => m.market === market) : state.markets
      return {
        fetch: { ...state, markets: marketStates },
        total90: counts.last,
        rows: rows.map(r => {
          const payload = (r.rawPayload && typeof r.rawPayload === 'object' ? r.rawPayload : {}) as Record<string, unknown>
          const fulfilment = r.orderId ? fulfilmentOfOrder.get(r.orderId) ?? null : null
          const response = typeof payload.yourResponse === 'string' && payload.yourResponse.trim() ? payload.yourResponse : null
          return {
            id: r.id,
            rating: r.rating,
            postedAt: r.postedAt.toISOString(),
            text: r.body,
            english: r.bodyEnglish,
            language: r.language,
            amazonOrderId: typeof payload.amazonOrderId === 'string' ? payload.amazonOrderId : null,
            orderId: r.orderId,
            fulfilmentWords: fulfilment === 'amazon' ? 'Amazon shipped it (FBA)' : fulfilment === 'seller' ? 'you shipped it' : null,
            status: r.triageStatus ?? 'NEW',
            replied: response != null || r._count.responses > 0 || r.triageStatus === 'RESPONDED',
            check: feedbackRemovalCheck({ text: r.body, english: r.bodyEnglish, themes: r.sentiment?.categories ?? null, postedAt: r.postedAt, fulfilment, now }),
          }
        }),
        rules: REMOVAL_RULES,
      }
    }),
  ])

  return { tiles, trend, spread, topics, requests: requestSection, watch, sellerFeedback }
}

// ── eBay ─────────────────────────────────────────────────────────────

/** The Inbox's period for one of the page's: 12 months is 365 days (the Inbox counts days). */
function inboxPeriod(period: ChannelPeriod): string {
  return period === '12m' ? '365' : period
}

/** Many eBay reads → one summary, with words for the ones that did not answer. */
export function summaryFrom(reads: ReadonlyArray<{ market: string | null; read: SummaryRead }>, accountWide: boolean): EbaySummary {
  if (reads.length === 0) {
    return { state: 'no_account', words: 'No eBay account is connected. Connect eBay in Settings › Channels to see eBay’s own numbers.', readAt: null, accountWide: false, accounts: 0, score: null, periods: [], dsr: [], dsrPeriod: null }
  }
  const ok = reads.filter((r): r is { market: string | null; read: Extract<SummaryRead, { ok: true }> } => r.read.ok)
  const failed = reads.filter(r => !r.read.ok)
  const combined = combineSummaries(ok.map(r => r.read.summary))
  const readAt = ok.map(r => r.read.readAt).sort()[0] ?? null
  const failWords = failed.length
    ? (failed[0].read as Extract<SummaryRead, { ok: false }>).words
    : null
  const state: EbaySummary['state'] = failed.length === 0 ? 'read' : ok.length === 0 ? 'not_read' : 'partial'
  const words = state === 'partial'
    ? `${failed.length === 1 ? 'One eBay account' : `${failed.length} eBay accounts`} could not be read, so these numbers leave ${failed.length === 1 ? 'it' : 'them'} out. ${failWords}`
    : failWords
  return {
    state,
    words,
    readAt,
    accountWide,
    accounts: reads.length,
    score: combined?.score ?? null,
    periods: combined?.periods ?? [],
    dsr: combined?.dsr ?? [],
    dsrPeriod: combined?.dsrPeriod ?? null,
  }
}

async function ebaySections(market: string | null, period: ChannelPeriod, bounds: PeriodBounds, now: Date): Promise<EbaySections> {
  const scope: Prisma.ReviewWhereInput = { channel: 'EBAY', ...(market ? { marketplace: market } : {}) }

  const summary = once(async (): Promise<EbaySummary> => {
    const connections = await prisma.channelConnection.findMany({
      where: { channelType: 'EBAY', isActive: true },
      select: { id: true, marketplace: true, isPrimary: true },
    })
    const { accounts, accountWide } = pageAccounts(connections.map(c => ({ id: c.id, market: parseMarket(c.marketplace), isPrimary: c.isPrimary })), market)
    const reads = await Promise.all(accounts.map(async a => ({ market: a.market, read: await readEbayFeedbackSummary(a.id) })))
    return summaryFrom(reads, accountWide)
  })

  const [readState, tiles, summarySection, feedback, topics, revisions] = await Promise.all([
    section('readState', async (): Promise<EbayReadState[]> => {
      const { sources } = await reviewSources(now)
      return sources
        .filter(s => s.channel === 'EBAY' && (!market || s.market === market))
        .map(s => ({ channel: 'EBAY' as const, market: s.market, label: channelMarketLabel('EBAY', s.market), ok: s.state === 'ok', reason: s.reason, since: s.since, reconnectHref: s.reconnectHref }))
    }),

    section('tiles', async (): Promise<EbayTiles> => {
      const [ratings, needReply, oldest, sum, buyers] = await Promise.all([
        prisma.review.findMany({
          where: visibleReviewWhere({ ...scope, postedAt: { ...(bounds.from ? { gte: bounds.from } : {}), lte: bounds.to } }),
          select: { rating: true },
          take: 100_000,
        }),
        prisma.review.count({ where: { AND: [needsReplyWhere(), scope] } }),
        prisma.review.findFirst({ where: { AND: [needsReplyWhere(), scope] }, orderBy: { postedAt: 'asc' }, select: { postedAt: true } }),
        summary().catch(() => null),
        buyersToRate(market, now).catch((err) => {
          logger.warn('[reviews-channel] buyers to rate failed', { error: err instanceof Error ? err.message : String(err) })
          return null
        }),
      ])
      const counts = feedbackTypeCounts(ratings.map(r => r.rating))
      const year = sum && sum.state !== 'not_read' && sum.state !== 'no_account' ? yearPeriod(sum) : null
      const ebayPct = positivePercent(year)
      return {
        ...counts,
        score: sum && (sum.state === 'read' || sum.state === 'partial') ? sum.score : null,
        positivePct: ebayPct ?? positivePercent(counts),
        positiveFrom: ebayPct != null ? 'ebay' : 'nexus',
        needReply,
        oldestWaitDays: oldest ? daysBetween(oldest.postedAt, now) : null,
        buyersToRate: buyers,
      }
    }),

    section('summary', () => summary()),

    section('feedback', async (): Promise<EbayFeedbackList> => {
      const page = await listInbox({ kind: 'seller', channel: 'EBAY', ...(market ? { market } : {}), period: inboxPeriod(period), page: 1, pageSize: 200 }, now)
      return { rows: page.rows, total: page.total, owners: page.facets.owners }
    }),

    section('ebayTopics', () => ebayTopicsSection(scope, bounds)),

    section('revisions', () => ebayRevisionsSection(scope, now)),
  ])

  return { readState, tiles, summary: summarySection, feedback, topics, revisions }
}

// ── Markets ──────────────────────────────────────────────────────────

/**
 * The markets a channel page exists for: where the business lists (active listings), where reviews or feedback arrived,
 * and — Amazon — where Amazon gives topics or the account takes part; eBay — the market of each connected account.
 */
export async function channelMarkets(channel: ReviewChannel): Promise<ChannelMarket[]> {
  const [listings, reviews, extra] = await Promise.all([
    prisma.channelListing.groupBy({ by: ['marketplace'], where: { channel, listingStatus: 'ACTIVE' } }),
    prisma.review.groupBy({ by: ['marketplace'], where: visibleReviewWhere({ channel }) }),
    channel === 'AMAZON'
      ? Promise.all([
          prisma.marketplace.findMany({ where: { channel: 'AMAZON', isActive: true, isParticipating: true }, select: { code: true } }),
          prisma.amazonReviewInsight.groupBy({ by: ['marketplace'] }),
        ]).then(([m, i]) => [...m.map(x => x.code), ...i.map(x => x.marketplace)])
      : prisma.channelConnection.findMany({ where: { channelType: 'EBAY', isActive: true }, select: { marketplace: true } }).then(c => c.map(x => x.marketplace)),
  ])
  return orderMarkets([...listings.map(l => l.marketplace), ...reviews.map(r => r.marketplace), ...extra]).map(code => ({
    code,
    label: marketWords(code) ?? code,
  }))
}

/** GET /api/reviews/area/channel-markets: both channels' markets (the Reviews sub-sidebar's Channels rows). */
export async function reviewChannelMarkets(): Promise<{ AMAZON: ChannelMarket[]; EBAY: ChannelMarket[] }> {
  const [amazon, ebay] = await Promise.all([channelMarkets('AMAZON'), channelMarkets('EBAY')])
  return { AMAZON: amazon, EBAY: ebay }
}
