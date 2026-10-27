/**
 * Reviews Overview — GET /api/reviews/area/overview (routes/reviews-area.routes.ts). One answer for the page, in
 * sections that fail ALONE: each is `{ ok: true, data }` or `{ ok: false, error }` (words), so a failed read shows only
 * that card's error and Try again — never zeros in its place.
 *
 * Sources (build spec §3.1): visible Review rows only (fixtures never count, review-visibility.ts); Amazon stars come
 * only from imported reviews, never a live Amazon number (ruling 5); Amazon themes are the Customer Feedback API topics
 * (AmazonReviewInsight, not on Amazon.nl); requests and the review rate are ReviewRequest rows with the reviews the
 * attribution job tied to them (the review-analytics heuristic, persisted on Review.attributedRequestId); alerts are
 * open ReviewSpike rows; channel state and setup problems come from review-sources.service.ts. The arithmetic is pure,
 * in overviewMath.ts.
 */
import type { Prisma } from '@prisma/client'
import prisma from '../../db.js'
import { logger } from '../../utils/logger.js'
import { countsInRating, needsReplyWhere, reviewKindOf, visibleReviewWhere } from './review-visibility.js'
import { NO_TOPICS_MARKETS, reviewSources, type ReviewSource, type SetupProblem } from './review-sources.service.js'
import {
  averageRating, bucketKeys, channelMarketLabel, channelWords, daysBetween, delta, parseOverviewPeriod, periodBounds,
  periodOf, rankWatch, ratingIn, ratingKindOf, reviewRate, round, sparkValues, sparkWindows, starCounts, starImpact,
  themeWords, trendBucket, trendPoints, type OverviewPeriod, type PeriodBounds, type RatingKind, type TrendBucket,
  type TrendPoint,
} from './overviewMath.js'

export type Section<T> = { ok: true; data: T } | { ok: false; error: string }

export interface OverviewTiles {
  avgRating: number | null
  avgDelta: number | null
  newReviews: number
  newDelta: number | null
  needReply: number
  oldestWaitDays: number | null
  requestsSent: number
  requestsFailed: number
  /** Percent, one decimal. */
  reviewRate: number | null
  /** Percentage points against the period before. */
  rateDelta: number | null
  openAlerts: number
  newAlertsToday: number
}

export interface OverviewSpread {
  /** 5 stars first. */
  counts: [number, number, number, number, number]
  product: number
  seller: number
  note: string | null
}

export interface OverviewChannelRow {
  channel: string
  market: string | null
  label: string
  ratingKind: RatingKind
  /** Stars (two decimals) or % positive; null = no rating data. */
  rating: number | null
  reviews: number
  /** Against the period before: stars, or % points for eBay. */
  change: number | null
  /** Requests sent; null where Nexus sends none. */
  sent: number | null
  /** Percent, one decimal. */
  rate: number | null
  lastReviewAt: string | null
  state: 'ok' | 'not_updating'
  reason: string | null
  since: string | null
  reconnectHref: string | null
  what: string
  lastNote: string | null
}

export interface OverviewTheme {
  /** A review theme (FIT_SIZING) or `amazon:<topic>`. */
  key: string
  label: string
  /** Percent of the reviews it is counted against (`shareOf`); null when unknown. */
  share: number | null
  shareOf: 'positive' | 'negative' | 'amazon'
  mentions: number
  source: 'amazon_topic' | 'review'
  quote: string | null
  quoteFrom: string | null
  english: string | null
  /** Stars against the overall average (reviews), or Amazon's own rating impact; null when unknown. */
  impact: number | null
  market: string | null
}

export interface OverviewWatchRow {
  productId: string
  name: string
  sku: string | null
  channel: string
  market: string | null
  where: string
  kind: RatingKind
  ratingNow: number | null
  ratingBefore: number | null
  change: number
  reviews: number
  topTheme: string | null
  spark: Array<number | null>
  tooFew: boolean
}

export interface ReviewsOverview {
  period: { key: OverviewPeriod; from: string | null; to: string; prevFrom: string | null; prevTo: string | null }
  generatedAt: string
  sections: {
    tiles: Section<OverviewTiles>
    trend: Section<{ bucket: TrendBucket; points: TrendPoint[] }>
    spread: Section<OverviewSpread>
    channels: Section<OverviewChannelRow[]>
    themes: Section<{ love: OverviewTheme[]; fix: OverviewTheme[] }>
    watch: Section<OverviewWatchRow[]>
    setup: Section<SetupProblem[]>
  }
}

const SECTION_ERROR: Record<keyof ReviewsOverview['sections'], string> = {
  tiles: 'The numbers at the top could not be read.',
  trend: 'The rating chart could not be read.',
  spread: 'The rating spread could not be read.',
  channels: 'The channels could not be read.',
  themes: 'The themes could not be read.',
  watch: 'The products to watch could not be read.',
  setup: 'Nexus could not check the review sources.',
}

async function section<K extends keyof ReviewsOverview['sections'], T>(name: K, run: () => Promise<T>): Promise<Section<T>> {
  try {
    return { ok: true, data: await run() }
  } catch (err) {
    logger.warn('[reviews-overview] section failed', { section: name, error: err instanceof Error ? err.message : String(err) })
    return { ok: false, error: `${SECTION_ERROR[name]} Try again in a moment.` }
  }
}

/** Run once, share the answer (and the failure) between sections. */
function once<T>(run: () => Promise<T>): () => Promise<T> {
  let p: Promise<T> | null = null
  return () => (p ??= run())
}

const CODE = /^[A-Z_]{2,20}$/

/** A channel or market code from the query string, upper case; anything else is no filter. */
export function scopeCode(raw: unknown): string | null {
  const value = typeof raw === 'string' ? raw.trim().toUpperCase() : ''
  return value && value !== 'ALL' && CODE.test(value) ? value : null
}

export interface OverviewInput {
  period?: unknown
  channel?: unknown
  market?: unknown
  now?: Date
}

/** Sentiment categories that are not a theme a person acts on. */
const NOT_A_THEME = new Set(['OTHER'])
const SPARK_DAYS = 42

type ReviewRow = {
  id: string
  channel: string
  marketplace: string | null
  rating: number | null
  postedAt: Date
  productId: string | null
  ingestSource: string | null
  kind: string | null
  sentiment: { label: string; categories: string[]; topPhrases: string[] } | null
}

const rowKey = (channel: string, market: string | null) => `${channel.toUpperCase()}|${market?.toUpperCase() ?? ''}`
const CHANNEL_ORDER = ['AMAZON', 'EBAY', 'SHOPIFY', 'ETSY']
/** What a channel gives when review-sources knows nothing of that market yet (only requests went there). */
const FALLBACK_WHAT: Record<string, string> = {
  AMAZON: 'No reviews imported',
  EBAY: 'Seller feedback',
  SHOPIFY: 'Store review app, by file import',
}

function quoteSource(row: ReviewRow): string {
  const where = row.marketplace ? ` · ${row.marketplace.toUpperCase()}` : ''
  if (row.ingestSource === 'IMPORT_CSV') return `Imported review · ${channelMarketLabel(row.channel, null)}${where}`
  return `${channelWords(row.channel)} ${reviewKindOf(row.channel, row.kind) === 'seller' ? 'feedback' : 'review'}${where}`
}

function quoted(text: string): string {
  const clean = text.replace(/\s+/g, ' ').trim()
  return /^[“"]/.test(clean) ? clean : `“${clean}”`
}

/** Review themes from the sentiment of the period's reviews, as a share of the positive (or negative) reviews. */
export function reviewThemes(rows: readonly ReviewRow[], polarity: 'POSITIVE' | 'NEGATIVE'): OverviewTheme[] {
  const overall = averageRating(rows.map(r => r.rating))
  const pool = rows.filter(r => r.sentiment?.label === polarity)
  const byTheme = new Map<string, { mentions: number; latest: ReviewRow | null }>()
  for (const r of pool) {
    for (const cat of new Set(r.sentiment!.categories)) {
      if (NOT_A_THEME.has(cat)) continue
      const slot = byTheme.get(cat) ?? { mentions: 0, latest: null }
      slot.mentions += 1
      if (r.sentiment!.topPhrases.length > 0 && (!slot.latest || r.postedAt > slot.latest.postedAt)) slot.latest = r
      byTheme.set(cat, slot)
    }
  }
  return [...byTheme.entries()].map(([key, slot]) => {
    const withTheme = rows.filter(r => r.sentiment?.categories.includes(key))
    return {
      key,
      label: themeWords(key),
      share: pool.length > 0 ? Math.round((slot.mentions / pool.length) * 100) : null,
      shareOf: polarity === 'POSITIVE' ? 'positive' as const : 'negative' as const,
      mentions: slot.mentions,
      source: 'review' as const,
      quote: slot.latest ? quoted(slot.latest.sentiment!.topPhrases[0]) : null,
      quoteFrom: slot.latest ? quoteSource(slot.latest) : null,
      // Translations arrive with the Inbox (PR B); until then the quote stands in its own language.
      english: null,
      impact: starImpact(averageRating(withTheme.map(r => r.rating)), overall),
      market: null,
    }
  })
}

type InsightTopic = { topic?: unknown; mentionCount?: unknown; ratingImpact?: unknown; snippets?: unknown }

/** Amazon's own topics (Customer Feedback API), merged over products and markets. */
export function amazonThemes(
  rows: ReadonlyArray<{ marketplace: string; reviewCount: number | null; positiveTopics: unknown; negativeTopics: unknown }>,
  polarity: 'POSITIVE' | 'NEGATIVE',
): OverviewTheme[] {
  const merged = new Map<string, { label: string; mentions: number; reviews: number; impact: number | null; quote: string | null; market: string | null; marketMentions: number }>()
  for (const row of rows) {
    const list = (polarity === 'POSITIVE' ? row.positiveTopics : row.negativeTopics) as InsightTopic[] | null
    if (!Array.isArray(list)) continue
    for (const t of list) {
      const label = typeof t?.topic === 'string' ? t.topic.trim() : ''
      if (!label) continue
      const id = label.toLowerCase()
      const mentions = Number(t.mentionCount) > 0 ? Number(t.mentionCount) : 0
      const impact = Number.isFinite(Number(t.ratingImpact)) && t.ratingImpact != null ? Number(t.ratingImpact) : null
      const snippet = Array.isArray(t.snippets) ? t.snippets.find((s): s is string => typeof s === 'string' && s.trim().length > 0) ?? null : null
      const slot = merged.get(id) ?? { label, mentions: 0, reviews: 0, impact: null, quote: null, market: null, marketMentions: -1 }
      slot.mentions += mentions
      slot.reviews += row.reviewCount ?? 0
      if (impact != null && (slot.impact == null || Math.abs(impact) > Math.abs(slot.impact))) slot.impact = impact
      if (mentions > slot.marketMentions) {
        slot.marketMentions = mentions
        slot.market = row.marketplace.toUpperCase()
        if (snippet) slot.quote = snippet
      } else if (!slot.quote && snippet) slot.quote = snippet
      merged.set(id, slot)
    }
  }
  return [...merged.entries()].filter(([, s]) => s.mentions > 0).map(([id, s]) => ({
    key: `amazon:${id}`,
    label: s.label,
    share: s.reviews > 0 ? Math.min(100, Math.round((s.mentions / s.reviews) * 100)) : null,
    shareOf: 'amazon' as const,
    mentions: s.mentions,
    source: 'amazon_topic' as const,
    quote: s.quote ? quoted(s.quote) : null,
    quoteFrom: `Amazon topic${s.market ? ` · ${s.market}` : ''}`,
    english: null,
    impact: s.impact == null ? null : round(s.impact, 1),
    market: s.market,
  }))
}

/** The four themes mentioned most, Amazon topics and review themes together. */
export function topThemes(themes: readonly OverviewTheme[], limit = 4): OverviewTheme[] {
  return [...themes].sort((a, b) => b.mentions - a.mentions || a.label.localeCompare(b.label)).slice(0, limit)
}

function startOfUtcDay(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()))
}

/** The Overview, every section read on its own. */
export async function reviewsOverview(input: OverviewInput = {}): Promise<ReviewsOverview> {
  const now = input.now ?? new Date()
  const period = parseOverviewPeriod(input.period)
  const channel = scopeCode(input.channel)
  const market = scopeCode(input.market)
  const bounds: PeriodBounds = periodBounds(period, now)

  const scope: Prisma.ReviewWhereInput = { ...(channel ? { channel } : {}), ...(market ? { marketplace: market } : {}) }
  const requestScope: Prisma.ReviewRequestWhereInput = { ...(channel ? { channel } : {}), ...(market ? { marketplace: market } : {}) }
  // The period, the one before it, and six weeks for the watch list's sparklines.
  const readFrom = bounds.prevFrom ?? bounds.from
  const sparkFrom = new Date(now.getTime() - SPARK_DAYS * 86_400_000)
  const lowerBound = readFrom == null ? null : readFrom < sparkFrom ? readFrom : sparkFrom

  const reviews = once(async (): Promise<ReviewRow[]> => prisma.review.findMany({
    where: visibleReviewWhere({ ...scope, postedAt: { ...(lowerBound ? { gte: lowerBound } : {}), lte: bounds.to } }),
    select: {
      id: true, channel: true, marketplace: true, rating: true, postedAt: true, productId: true, ingestSource: true, kind: true,
      sentiment: { select: { label: true, categories: true, topPhrases: true } },
    },
    orderBy: { postedAt: 'desc' },
    take: 100_000,
  }))
  const split = once(async () => {
    const rows = await reviews()
    return { now: rows.filter(r => periodOf(r.postedAt, bounds) === 'now'), prev: rows.filter(r => periodOf(r.postedAt, bounds) === 'prev'), all: rows }
  })
  const requests = once(async () => prisma.reviewRequest.findMany({
    where: { ...requestScope, status: 'SENT', sentAt: { ...(readFrom ? { gte: readFrom } : {}), lte: bounds.to } },
    select: { channel: true, marketplace: true, sentAt: true, _count: { select: { attributedReviews: { where: visibleReviewWhere() } } } },
  }))
  const requestSplit = once(async () => {
    const rows = await requests()
    const tag = (at: Date | null) => (at ? periodOf(at, bounds) : null)
    return { now: rows.filter(r => tag(r.sentAt) === 'now'), prev: rows.filter(r => tag(r.sentAt) === 'prev') }
  })
  const sources = once(() => reviewSources(now))
  // Where reviews can arrive at all (any visible review, any time): a request sent where no review ever arrives — Amazon
  // before a person imports reviews — cannot be matched, so it has no rate rather than a rate of 0.
  const reviewedKeys = once(async () => {
    const groups = await prisma.review.groupBy({ by: ['channel', 'marketplace'], where: visibleReviewWhere(scope) })
    return new Set(groups.map(g => rowKey(g.channel, g.marketplace)))
  })

  const [tiles, trend, spread, channels, themes, watch, setup] = await Promise.all([
    section('tiles', async (): Promise<OverviewTiles> => {
      const [{ now: rowsNow, prev: rowsPrev }, reqs, needReply, oldest, failed, openAlerts, newAlertsToday] = await Promise.all([
        split(),
        requestSplit().then(async r => {
          const keys = await reviewedKeys()
          const matchable = (rows: typeof r.now) => rows.filter(x => keys.has(rowKey(x.channel, x.marketplace)))
          return { now: matchable(r.now), prev: matchable(r.prev), sentNow: r.now.length }
        }),
        prisma.review.count({ where: { AND: [needsReplyWhere(), scope] } }),
        prisma.review.findFirst({ where: { AND: [needsReplyWhere(), scope] }, orderBy: { postedAt: 'asc' }, select: { postedAt: true } }),
        prisma.reviewRequest.count({ where: { ...requestScope, status: 'FAILED', updatedAt: { ...(bounds.from ? { gte: bounds.from } : {}), lte: bounds.to } } }),
        prisma.reviewSpike.count({ where: { status: 'OPEN', ...(market ? { marketplace: market } : {}) } }),
        prisma.reviewSpike.count({ where: { status: 'OPEN', detectedAt: { gte: startOfUtcDay(now) }, ...(market ? { marketplace: market } : {}) } }),
      ])
      const hasPrev = bounds.prevFrom != null
      // Amazon's 1–3 star seller feedback is counted, never averaged (review-visibility.ts `countsInRating`).
      const avgNow = averageRating(rowsNow.filter(countsInRating).map(r => r.rating))
      const avgPrev = hasPrev ? averageRating(rowsPrev.filter(countsInRating).map(r => r.rating)) : null
      const followed = (rows: Array<{ _count: { attributedReviews: number } }>) => rows.filter(r => r._count.attributedReviews > 0).length
      const rateNow = reviewRate(reqs.now.length, followed(reqs.now))
      const ratePrev = hasPrev ? reviewRate(reqs.prev.length, followed(reqs.prev)) : null
      return {
        avgRating: avgNow == null ? null : round(avgNow, 1),
        avgDelta: delta(avgNow, avgPrev, 1),
        newReviews: rowsNow.length,
        newDelta: hasPrev ? rowsNow.length - rowsPrev.length : null,
        needReply,
        oldestWaitDays: oldest ? daysBetween(oldest.postedAt, now) : null,
        requestsSent: reqs.sentNow,
        requestsFailed: failed,
        reviewRate: rateNow == null ? null : round(rateNow * 100, 1),
        rateDelta: rateNow == null || ratePrev == null ? null : round((rateNow - ratePrev) * 100, 1),
        openAlerts,
        newAlertsToday,
      }
    }),

    section('trend', async () => {
      const { now: rowsNow } = await split()
      const bucket = trendBucket(period)
      const earliest = rowsNow.length ? rowsNow[rowsNow.length - 1].postedAt : new Date(now.getTime() - 30 * 86_400_000)
      const from = bounds.from ?? earliest
      return { bucket, points: trendPoints(rowsNow.filter(countsInRating), bucketKeys(from, bounds.to, bucket), bucket) }
    }),

    section('spread', async (): Promise<OverviewSpread> => {
      const { now: rowsNow } = await split()
      const unrated = rowsNow.filter(r => r.rating == null).length
      return {
        counts: starCounts(rowsNow.filter(countsInRating).map(r => r.rating)),
        product: rowsNow.filter(r => reviewKindOf(r.channel, r.kind) === 'product').length,
        seller: rowsNow.filter(r => reviewKindOf(r.channel, r.kind) === 'seller').length,
        note: unrated > 0 ? `${unrated.toLocaleString('en')} ${unrated === 1 ? 'review has' : 'reviews have'} no star rating, so ${unrated === 1 ? 'it is' : 'they are'} not in the spread.` : null,
      }
    }),

    section('channels', async (): Promise<OverviewChannelRow[]> => {
      const [{ now: rowsNow, prev: rowsPrev }, reqs, { sources: known }, reviewed] = await Promise.all([split(), requestSplit(), sources(), reviewedKeys()])
      const keys = new Map<string, { channel: string; market: string | null }>()
      const add = (c: string, m: string | null) => {
        const ch = c.toUpperCase()
        const mk = m?.toUpperCase() ?? null
        if (channel && ch !== channel) return
        if (market && mk !== market) return
        keys.set(rowKey(ch, mk), { channel: ch, market: mk })
      }
      for (const s of known) add(s.channel, s.market)
      for (const r of rowsNow) add(r.channel, r.marketplace)
      for (const r of reqs.now) add(r.channel, r.marketplace)
      const sourceOf = new Map<string, ReviewSource>(known.map(s => [rowKey(s.channel, s.market), s]))
      const hasPrev = bounds.prevFrom != null
      const rows = [...keys.values()].map(({ channel: ch, market: mk }) => {
        const k = rowKey(ch, mk)
        const mine = rowsNow.filter(r => rowKey(r.channel, r.marketplace) === k)
        const before = rowsPrev.filter(r => rowKey(r.channel, r.marketplace) === k)
        const kind = ratingKindOf(ch)
        const rating = ratingIn(kind, mine.filter(countsInRating).map(r => r.rating))
        const sent = reqs.now.filter(r => rowKey(r.channel, r.marketplace) === k)
        const rate = reviewed.has(k) ? reviewRate(sent.length, sent.filter(r => r._count.attributedReviews > 0).length) : null
        const src = sourceOf.get(k)
        const newestHere = mine.reduce<Date | null>((best, r) => (!best || r.postedAt > best ? r.postedAt : best), null)
        return {
          channel: ch,
          market: mk,
          label: channelMarketLabel(ch, mk),
          ratingKind: kind,
          rating,
          reviews: mine.length,
          change: hasPrev ? delta(rating, ratingIn(kind, before.filter(countsInRating).map(r => r.rating)), 1) : null,
          // Etsy asks its buyers itself: Nexus sends no requests there.
          sent: ch === 'ETSY' ? null : sent.length,
          rate: ch === 'ETSY' || rate == null ? null : round(rate * 100, 1),
          lastReviewAt: src?.lastReviewAt ?? newestHere?.toISOString() ?? null,
          state: src?.state ?? 'ok',
          reason: src?.reason ?? null,
          since: src?.since ?? null,
          reconnectHref: src?.reconnectHref ?? null,
          what: src?.what ?? FALLBACK_WHAT[ch] ?? (reviewKindOf(ch) === 'seller' ? 'Seller feedback' : 'Reviews'),
          lastNote: src?.lastNote ?? null,
        } satisfies OverviewChannelRow
      })
      const order = (c: string) => {
        const i = CHANNEL_ORDER.indexOf(c)
        return i === -1 ? CHANNEL_ORDER.length : i
      }
      return rows.sort((a, b) => order(a.channel) - order(b.channel) || b.reviews - a.reviews || (a.market ?? '').localeCompare(b.market ?? ''))
    }),

    section('themes', async () => {
      const { now: rowsNow } = await split()
      const wantAmazon = (!channel || channel === 'AMAZON') && !(market && NO_TOPICS_MARKETS.has(market))
      const topics = wantAmazon
        ? await prisma.amazonReviewInsight.findMany({
            where: { accessStatus: 'OK', marketplace: market ? market : { notIn: [...NO_TOPICS_MARKETS] } },
            select: { marketplace: true, reviewCount: true, positiveTopics: true, negativeTopics: true },
          })
        : []
      return {
        love: topThemes([...reviewThemes(rowsNow, 'POSITIVE'), ...amazonThemes(topics, 'POSITIVE')]),
        fix: topThemes([...reviewThemes(rowsNow, 'NEGATIVE'), ...amazonThemes(topics, 'NEGATIVE')]),
      }
    }),

    section('watch', async (): Promise<OverviewWatchRow[]> => {
      if (bounds.prevFrom == null) return []
      const { now: rowsNow, prev: rowsPrev, all } = await split()
      type Group = { key: string; productId: string; channel: string; market: string | null; now: ReviewRow[]; before: ReviewRow[] }
      const groups = new Map<string, Group>()
      const put = (r: ReviewRow, side: 'now' | 'before') => {
        if (!r.productId || r.rating == null) return
        const k = `${r.productId}|${rowKey(r.channel, r.marketplace)}`
        const g = groups.get(k) ?? { key: k, productId: r.productId, channel: r.channel.toUpperCase(), market: r.marketplace?.toUpperCase() ?? null, now: [], before: [] }
        g[side].push(r)
        groups.set(k, g)
      }
      for (const r of rowsNow) put(r, 'now')
      for (const r of rowsPrev) put(r, 'before')
      const ranked = rankWatch([...groups.values()].map(g => {
        const kind = ratingKindOf(g.channel)
        return { ...g, kind, ratingNow: ratingIn(kind, g.now.map(r => r.rating)), ratingBefore: ratingIn(kind, g.before.map(r => r.rating)), countNow: g.now.length, countBefore: g.before.length }
      }))
      if (ranked.length === 0) return []
      const products = await prisma.product.findMany({ where: { id: { in: [...new Set(ranked.map(r => r.productId))] } }, select: { id: true, name: true, sku: true } })
      const productOf = new Map(products.map(p => [p.id, p]))
      const windows = sparkWindows(now)
      return ranked.map(g => {
        const complaints = new Map<string, number>()
        for (const r of g.now) {
          if (r.sentiment?.label !== 'NEGATIVE' && (r.rating ?? 5) > 2) continue
          for (const cat of r.sentiment?.categories ?? []) if (!NOT_A_THEME.has(cat)) complaints.set(cat, (complaints.get(cat) ?? 0) + 1)
        }
        const top = [...complaints.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null
        const sparkRows = all.filter(r => r.productId === g.productId && rowKey(r.channel, r.marketplace) === rowKey(g.channel, g.market))
        const spark = sparkValues(g.kind, sparkRows, windows)
        const product = productOf.get(g.productId)
        return {
          productId: g.productId,
          name: product?.name ?? product?.sku ?? 'Product',
          sku: product?.sku ?? null,
          channel: g.channel,
          market: g.market,
          where: channelMarketLabel(g.channel, g.market),
          kind: g.kind,
          ratingNow: g.ratingNow == null ? null : round(g.ratingNow, 1),
          ratingBefore: g.ratingBefore == null ? null : round(g.ratingBefore, 1),
          change: g.change,
          reviews: g.countNow,
          topTheme: top ? themeWords(top) : null,
          spark: spark.values,
          tooFew: spark.tooFew,
        }
      })
    }),

    section('setup', async () => (await sources()).setup),
  ])

  return {
    period: {
      key: period,
      from: bounds.from?.toISOString() ?? null,
      to: bounds.to.toISOString(),
      prevFrom: bounds.prevFrom?.toISOString() ?? null,
      prevTo: bounds.prevTo?.toISOString() ?? null,
    },
    generatedAt: now.toISOString(),
    sections: { tiles, trend, spread, channels, themes, watch, setup },
  }
}
