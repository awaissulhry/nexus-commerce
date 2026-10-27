/**
 * Reviews Insights (2026-10-26, PR E) — the pure rules behind the five Insights pages (Themes, Products, the product
 * pop-up, Alerts, Fixes, Brief): the scope every page shares (channel, market, period), which theme an Amazon topic
 * belongs to, star impact, a theme's mood, mentions a week, return rate and the words a rating's source is shown with.
 * No database and no clock of its own (every function takes `now`), so review-themes.vitest.test.ts checks each rule
 * with plain numbers.
 *
 * Amazon (hub ruling 5): the Customer Feedback API gives TOPICS only — mentions, share of reviews, effect on stars,
 * short English snippets — for the UK, Germany, France, Italy and Spain, never Amazon.nl. It gives no star rating,
 * average or count, so an Amazon star here comes only from reviews a person imported, and says so.
 */
import { averageRating, channelWords, marketWords, periodBounds, round, themeWords, type PeriodBounds } from './overviewMath.js'
import { isImportedSource } from './review-inbox-query.js'
import { countsAsStars } from './review-rating.js'
import { isAutomaticFeedback } from './review-visibility.js'

// ── Scope ────────────────────────────────────────────────────────────

export const INSIGHT_PERIODS = ['7d', '30d', '90d', '12m'] as const
export type InsightPeriod = (typeof INSIGHT_PERIODS)[number]
export const DEFAULT_INSIGHT_PERIOD: InsightPeriod = '30d'

/** A period from the query string; anything else is the default (30 days). */
export function parseInsightPeriod(raw: unknown): InsightPeriod {
  const value = typeof raw === 'string' ? raw.trim().toLowerCase() : ''
  return (INSIGHT_PERIODS as readonly string[]).includes(value) ? (value as InsightPeriod) : DEFAULT_INSIGHT_PERIOD
}

/** The period and the one before it, of the same length (the Overview's rule). */
export function insightBounds(period: InsightPeriod, now: Date): PeriodBounds & { from: Date; prevFrom: Date; prevTo: Date } {
  return periodBounds(period, now) as PeriodBounds & { from: Date; prevFrom: Date; prevTo: Date }
}

export const INSIGHT_CHANNELS = ['AMAZON', 'EBAY', 'SHOPIFY', 'ETSY'] as const

export interface InsightScope {
  /** 'AMAZON' | 'EBAY' | 'SHOPIFY' | 'ETSY', or null for every channel. */
  channel: string | null
  /** A market code ('DE'), or null for every market. */
  market: string | null
}

/** The channel-and-market picker from the query string. Unknown values mean "all" (never a 400 for a stale link). */
export function parseInsightScope(raw: { channel?: unknown; market?: unknown; marketplace?: unknown } = {}): InsightScope {
  const channelText = typeof raw.channel === 'string' ? raw.channel.trim().toUpperCase() : ''
  const channel = (INSIGHT_CHANNELS as readonly string[]).includes(channelText) ? channelText : null
  const marketRaw = typeof raw.market === 'string' && raw.market.trim() ? raw.market : raw.marketplace
  const marketText = typeof marketRaw === 'string' ? marketRaw.trim().toUpperCase() : ''
  const market = /^[A-Z]{2,8}$/.test(marketText) && marketText !== 'ALL' ? (marketText === 'GB' ? 'UK' : marketText) : null
  return { channel, market }
}

/** Where the Customer Feedback API gives topics (never Amazon.nl). */
export const AMAZON_TOPIC_MARKETS: readonly string[] = ['UK', 'DE', 'FR', 'IT', 'ES']

/** The Amazon markets whose topics belong in a scope: none when another channel is picked or the market has none. */
export function amazonTopicMarkets(scope: InsightScope): string[] {
  if (scope.channel && scope.channel !== 'AMAZON') return []
  if (scope.market) return AMAZON_TOPIC_MARKETS.includes(scope.market) ? [scope.market] : []
  return [...AMAZON_TOPIC_MARKETS]
}

// ── Themes ───────────────────────────────────────────────────────────

/** The review themes (ReviewSentiment.categories), in the order the pages list them when nothing else decides. */
export const THEME_KEYS = ['FIT_SIZING', 'COMFORT', 'DURABILITY', 'QUALITY', 'VALUE', 'DESIGN', 'SHIPPING', 'SAFETY', 'OTHER'] as const
export type ThemeKey = (typeof THEME_KEYS)[number]

/** A theme needs this many mentions before it gets a mood, a star impact or a trend line ("too few to trend"). */
export const MIN_THEME_MENTIONS = 5

/**
 * Which review theme an Amazon topic belongs to, from its words (Amazon names its own topics, in English: "Runs
 * small", "Comfortable on long rides"). First rule that matches wins; nothing matches → OTHER.
 */
const TOPIC_RULES: ReadonlyArray<readonly [RegExp, ThemeKey]> = [
  [/\b(size|sizes|sizing|fit|fits|fitting|small|smaller|large|larger|tight|loose|big|bigger|narrow|wide|sleeves?)\b/i, 'FIT_SIZING'],
  [/\b(safe|safety|protect\w*|armou?r|ce|impact|crash\w*)\b/i, 'SAFETY'],
  [/\b(ship\w*|deliver\w*|arriv\w*|packag\w*|packed|parcel|courier)\b/i, 'SHIPPING'],
  [/\b(durab\w*|broke|broken|break\w*|tear|torn|ripped|stitch\w*|seams?|zips?|zipper|wear|lasting|apart)\b/i, 'DURABILITY'],
  [/\b(comfort\w*|breath\w*|warm\w*|cool|soft|padding|padded|cosy|cozy|light)\b/i, 'COMFORT'],
  [/\b(price|priced|value|money|expensive|cheap|cost\w*|worth)\b/i, 'VALUE'],
  [/\b(design\w*|look|looks|colou?rs?|style|stylish|beautiful|appearance|pretty)\b/i, 'DESIGN'],
  [/\b(quality|material\w*|made|build|built|construction|sturdy|solid|well)\b/i, 'QUALITY'],
]

export function amazonTopicTheme(topic: string): ThemeKey {
  for (const [rule, key] of TOPIC_RULES) if (rule.test(topic)) return key
  return 'OTHER'
}

export type ThemeMood = 'positive' | 'negative' | 'mixed' | 'too_few'

/** Mostly negative (≥ 60 % of the mentions), mostly positive (≥ 60 %), mixed, or too few to say. */
export function themeMood(positive: number, negative: number, mentions: number): ThemeMood {
  if (mentions < MIN_THEME_MENTIONS) return 'too_few'
  if (negative / mentions >= 0.6) return 'negative'
  if (positive / mentions >= 0.6) return 'positive'
  return 'mixed'
}

/** `n` of `of` in percent with one decimal; nothing to count against → null. */
export function pct(n: number, of: number, digits = 1): number | null {
  return of > 0 ? round((n / of) * 100, digits) : null
}

/**
 * How many stars the rated reviews that mention a theme sit above or below the overall average (two decimals). Not
 * measurable (null) when every rating of the period is the same (live audit B11: all 5 stars read "0.00 ★"): no theme
 * can sit above or below then. `allRated` = every star rating of the period; left out, only the theme's own count.
 */
export function themeStarImpact(withTheme: ReadonlyArray<number | null>, overall: number | null, minRated = MIN_THEME_MENTIONS, allRated?: ReadonlyArray<number | null>): number | null {
  const rated = withTheme.filter((r): r is number => r != null)
  if (rated.length < minRated || overall == null) return null
  if (allRated && new Set(allRated.filter((r): r is number => r != null)).size < 2) return null
  const avg = averageRating(rated)
  return avg == null ? null : round(avg - overall, 2)
}

const DAY = 86_400_000

/** Mentions a week for `weeks` weeks ending at `now`, oldest first. */
export function weeklyCounts(dates: ReadonlyArray<Date>, now: Date, weeks = 8): number[] {
  const counts = new Array<number>(weeks).fill(0)
  const end = now.getTime()
  for (const d of dates) {
    const age = end - d.getTime()
    if (age < 0) continue
    const index = weeks - 1 - Math.floor(age / (7 * DAY))
    if (index >= 0) counts[index] += 1
  }
  return counts
}

/** The middle value; none → null. */
export function median(values: ReadonlyArray<number>): number | null {
  if (values.length === 0) return null
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
}

/** Where a quote comes from, in words: "Amazon topic · DE", "eBay feedback · IT", "Imported review · Amazon · FR". */
export function snippetFrom(source: 'amazon_topic' | 'review', channel: string, market: string | null, ingestSource?: string | null): string {
  const where = market ? ` · ${market.toUpperCase()}` : ''
  if (source === 'amazon_topic') return `Amazon topic${where}`
  if (isImportedSource(ingestSource)) return `Imported review · ${channelWords(channel)}${where}`
  return `${channelWords(channel)} ${channel.toUpperCase() === 'EBAY' ? 'feedback' : 'review'}${where}`
}

/** A quote cut to fit a card (no quotation marks: the page adds them). */
export function clip(text: string | null | undefined, max = 140): string | null {
  const clean = (text ?? '').replace(/\s+/g, ' ').trim().replace(/^[“"]|[”"]$/g, '')
  if (!clean) return null
  return clean.length > max ? `${clean.slice(0, max - 1).trimEnd()}…` : clean
}

// ── Amazon topics (AmazonReviewInsight.positiveTopics / negativeTopics) ──

export interface TopicRow {
  marketplace: string
  productId?: string | null
  fetchedAt: Date
  accessStatus?: string
  positiveTopics: unknown
  negativeTopics: unknown
}

export interface ParsedTopic {
  theme: ThemeKey
  topic: string
  polarity: 'positive' | 'negative'
  mentions: number
  /** Amazon's own "share of reviews" (percent), when it sent one. */
  share: number | null
  /** Amazon's own effect on the star rating. */
  starEffect: number | null
  snippets: string[]
  market: string
  productId: string | null
  fetchedAt: Date
}

const finite = (v: unknown): number | null => (v != null && v !== '' && Number.isFinite(Number(v)) ? Number(v) : null)

/** Every topic of every row, each with the theme it belongs to. */
export function parseTopicRows(rows: ReadonlyArray<TopicRow>): ParsedTopic[] {
  const out: ParsedTopic[] = []
  for (const row of rows) {
    for (const polarity of ['positive', 'negative'] as const) {
      const list = polarity === 'positive' ? row.positiveTopics : row.negativeTopics
      if (!Array.isArray(list)) continue
      for (const raw of list as Array<Record<string, unknown>>) {
        const topic = typeof raw?.topic === 'string' ? raw.topic.trim() : ''
        if (!topic) continue
        const mentions = Math.max(0, finite(raw.mentionCount) ?? 0)
        const snippets = Array.isArray(raw.snippets) ? (raw.snippets as unknown[]).filter((s): s is string => typeof s === 'string' && s.trim().length > 0) : []
        out.push({
          theme: amazonTopicTheme(topic),
          topic,
          polarity,
          mentions,
          share: finite(raw.share),
          starEffect: finite(raw.ratingImpact),
          snippets,
          market: row.marketplace.toUpperCase(),
          productId: row.productId ?? null,
          fetchedAt: row.fetchedAt,
        })
      }
    }
  }
  return out
}

// ── The Themes board ─────────────────────────────────────────────────

export interface ThemeReviewRow {
  id: string
  channel: string
  marketplace: string | null
  productId?: string | null
  rating: number | null
  postedAt: Date
  ingestSource: string | null
  /** `Review.kind`; null on older rows. Amazon's 1–3 star seller feedback never counts in an average. */
  kind?: string | null
  body: string
  bodyEnglish: string | null
  language: string | null
  sentiment: { label: string; categories: string[]; topPhrases: string[] } | null
}

export interface ThemeSnippet {
  text: string
  /** The text in English; null when it is English already, or not translated yet (the page says so). */
  english: string | null
  source: 'amazon_topic' | 'review'
  channel: string
  market: string | null
  /** "Amazon topic · DE", "eBay feedback · IT", "Imported review · Amazon · FR". */
  from: string
  reviewId: string | null
}

export interface InsightTheme {
  key: ThemeKey
  label: string
  mood: ThemeMood
  /** Reviews that mention it plus Amazon's topic mentions. */
  mentions: number
  /** Percent of the reviews read that mention it; when only Amazon's topics name it, Amazon's own share of reviews. */
  share: number | null
  /** Stars above or below the average (two decimals); null when too few rated mentions. */
  starImpact: number | null
  /** Where the star impact comes from: the reviews' stars, or Amazon's own "effect on stars". */
  starImpactFrom: 'reviews' | 'amazon_topic' | null
  /** Share points against the period before (reviews only); null when there is nothing to compare. */
  change: number | null
  /** Mentions a week, 8 weeks, oldest first (reviews only); null = too few to trend. */
  trend: number[] | null
  tooFew: boolean
  sources: { reviews: number; amazonTopics: number }
  snippets: ThemeSnippet[]
}

export type ThemeSort = 'mentions' | 'impact' | 'change'

export function parseThemeSort(raw: unknown): ThemeSort {
  return raw === 'impact' || raw === 'change' ? raw : 'mentions'
}

function reviewSnippet(row: ThemeReviewRow): ThemeSnippet | null {
  const english = row.language && row.language.toLowerCase() !== 'en' ? clip(row.bodyEnglish) : null
  const phrase = row.sentiment?.topPhrases.find((p) => p.trim().length > 0)
  // With a translation, quote the review and its English; without, its own short phrase reads best.
  const text = english ? clip(row.body) : clip(phrase ?? row.body)
  if (!text) return null
  return {
    text,
    english,
    source: 'review',
    channel: row.channel,
    market: row.marketplace,
    from: snippetFrom('review', row.channel, row.marketplace, row.ingestSource),
    reviewId: row.id,
  }
}

function weighted(items: ReadonlyArray<{ value: number | null; weight: number }>, digits: number): number | null {
  let sum = 0
  let total = 0
  for (const item of items) {
    if (item.value == null || !(item.weight > 0)) continue
    sum += item.value * item.weight
    total += item.weight
  }
  return total > 0 ? round(sum / total, digits) : null
}

/**
 * The Themes board: one row per theme with mentions, from the period's reviews (`rows`) and the Amazon topics in
 * scope (`topics`). `prevRows` is the period before (for the change), `trendRows` the last 8 weeks (for the line).
 * A review can mention several themes. Themes with no mention are left out.
 */
export function buildThemes(input: {
  rows: ReadonlyArray<ThemeReviewRow>
  prevRows: ReadonlyArray<ThemeReviewRow>
  trendRows: ReadonlyArray<ThemeReviewRow>
  topics: ReadonlyArray<ParsedTopic>
  now: Date
}): InsightTheme[] {
  // eBay's automatic feedback is eBay's text, not the buyer's: never a buyer theme (live audit B10).
  const buyers = (list: ReadonlyArray<ThemeReviewRow>) => list.filter((r) => !isAutomaticFeedback(r))
  const { topics, now } = input
  const [rows, prevRows, trendRows] = [buyers(input.rows), buyers(input.prevRows), buyers(input.trendRows)]
  // Stars of product reviews only (review-rating.ts — eBay feedback is never stars, Amazon's only from imported reviews).
  const starRatings = rows.filter(countsAsStars).map((r) => r.rating)
  const overall = averageRating(starRatings)
  const out: InsightTheme[] = []
  for (const key of THEME_KEYS) {
    const mentioning = rows.filter((r) => r.sentiment?.categories.includes(key))
    const amazon = topics.filter((t) => t.theme === key)
    const amazonMentions = amazon.reduce((n, t) => n + t.mentions, 0)
    const mentions = mentioning.length + amazonMentions
    if (mentions === 0) continue

    const positive = mentioning.filter((r) => r.sentiment?.label === 'POSITIVE').length + amazon.filter((t) => t.polarity === 'positive').reduce((n, t) => n + t.mentions, 0)
    const negative = mentioning.filter((r) => r.sentiment?.label === 'NEGATIVE').length + amazon.filter((t) => t.polarity === 'negative').reduce((n, t) => n + t.mentions, 0)
    const tooFew = mentions < MIN_THEME_MENTIONS

    const reviewShare = pct(mentioning.length, rows.length)
    const amazonShare = weighted(amazon.map((t) => ({ value: t.share, weight: t.mentions })), 1)
    // The reviews' own share when they mention it; a theme only Amazon's topics name shows Amazon's share of reviews.
    const share = mentioning.length > 0 || amazonShare == null ? reviewShare : amazonShare

    const reviewImpact = tooFew ? null : themeStarImpact(mentioning.filter(countsAsStars).map((r) => r.rating), overall, MIN_THEME_MENTIONS, starRatings)
    const amazonImpact = tooFew ? null : weighted(amazon.map((t) => ({ value: t.starEffect, weight: t.mentions })), 2)
    const starImpact = reviewImpact ?? amazonImpact
    const starImpactFrom = reviewImpact != null ? 'reviews' : amazonImpact != null ? 'amazon_topic' : null

    const prevShare = pct(prevRows.filter((r) => r.sentiment?.categories.includes(key)).length, prevRows.length)
    const change = reviewShare != null && prevShare != null && mentioning.length > 0 ? round(reviewShare - prevShare, 1) : null

    const trendDates = trendRows.filter((r) => r.sentiment?.categories.includes(key)).map((r) => r.postedAt)
    const trend = trendDates.length >= MIN_THEME_MENTIONS ? weeklyCounts(trendDates, now) : null

    // Two quotes: the newest review that says something, and Amazon's own words (or a second review).
    const snippets: ThemeSnippet[] = []
    const newest = [...mentioning].sort((a, b) => b.postedAt.getTime() - a.postedAt.getTime())
    const pushReview = () => {
      for (const row of newest) {
        if (snippets.some((s) => s.reviewId === row.id)) continue
        const s = reviewSnippet(row)
        if (s) {
          snippets.push(s)
          return true
        }
      }
      return false
    }
    pushReview()
    const topTopic = [...amazon].filter((t) => t.snippets.length > 0).sort((a, b) => b.mentions - a.mentions)[0]
    if (topTopic) {
      const text = clip(topTopic.snippets[0])!
      snippets.push({ text, english: null, source: 'amazon_topic', channel: 'AMAZON', market: topTopic.market, from: snippetFrom('amazon_topic', 'AMAZON', topTopic.market), reviewId: null })
    } else pushReview()

    out.push({
      key,
      label: themeWords(key),
      mood: themeMood(positive, negative, mentions),
      mentions,
      share,
      starImpact,
      starImpactFrom,
      change,
      trend,
      tooFew,
      sources: { reviews: mentioning.length, amazonTopics: amazonMentions },
      snippets,
    })
  }
  return out
}

/** Mentions (most first), star impact (most harmful first) or change (biggest rise first); unknowns last. */
export function sortThemes(themes: readonly InsightTheme[], sort: ThemeSort): InsightTheme[] {
  const value = (t: InsightTheme): number | null => (sort === 'impact' ? t.starImpact : sort === 'change' ? t.change : t.mentions)
  return [...themes].sort((a, b) => {
    const va = value(a)
    const vb = value(b)
    if (va == null && vb == null) return b.mentions - a.mentions || a.label.localeCompare(b.label)
    if (va == null) return 1
    if (vb == null) return -1
    const diff = sort === 'impact' ? va - vb : vb - va
    return diff || b.mentions - a.mentions || a.label.localeCompare(b.label)
  })
}

export interface ThemesSummary {
  reviewsRead: number
  /** Percent of the rated reviews with 1 or 2 stars. */
  negativeShare: number | null
  /** Points against the period before. */
  negativeShareChange: number | null
  biggestRiser: { key: ThemeKey; label: string; change: number } | null
  /** Themes with mentions, "Other" not counted. */
  themeCount: number
}

function negativeShareOf(rows: ReadonlyArray<ThemeReviewRow>): number | null {
  const rated = rows.filter((r) => r.rating != null)
  return pct(rated.filter((r) => (r.rating as number) <= 2).length, rated.length)
}

export function themesSummary(rows: ReadonlyArray<ThemeReviewRow>, prevRows: ReadonlyArray<ThemeReviewRow>, themes: readonly InsightTheme[]): ThemesSummary {
  const now = negativeShareOf(rows)
  const before = negativeShareOf(prevRows)
  const riser = themes.filter((t) => t.key !== 'OTHER' && t.change != null && t.change > 0).sort((a, b) => (b.change as number) - (a.change as number))[0]
  return {
    reviewsRead: rows.length,
    negativeShare: now,
    negativeShareChange: now != null && before != null ? round(now - before, 1) : null,
    biggestRiser: riser ? { key: riser.key, label: riser.label, change: riser.change as number } : null,
    themeCount: themes.filter((t) => t.key !== 'OTHER').length,
  }
}

// ── Products ─────────────────────────────────────────────────────────

/** A product needs this many rated reviews in the period before it shows a rating ("too few to rate"). */
export const MIN_PRODUCT_RATINGS = 3

/** Return rate: returns with a reason over orders (percent, one decimal); no orders → null. */
export function returnRate(returnsWithReason: number, orders: number): number | null {
  return orders > 0 ? round((Math.min(returnsWithReason, orders) / orders) * 100, 1) : null
}

/** A return's reason as a row label: trimmed, first letter upper case; none → null (it does not count). */
export function reasonWords(reason: string | null | undefined): string | null {
  const clean = (reason ?? '').replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim()
  if (!clean) return null
  const lower = clean.toLowerCase()
  return lower.charAt(0).toUpperCase() + lower.slice(1)
}

/**
 * The words a rating is shown with, per channel (ruling 5; the ONE rating, review-rating.ts): an Amazon star comes only
 * from reviews a person imported; with none, Amazon has no rating to show. eBay is "% positive" feedback.
 */
export function ratingSourceWords(channel: string, ingestSources: ReadonlyArray<string | null>): string {
  const ch = channel.toUpperCase()
  if (ch === 'AMAZON') {
    if (!ingestSources.some((s) => isImportedSource(s))) return 'No rating data from Amazon — import reviews'
    return 'stars from imported reviews'
  }
  if (ch === 'EBAY') return 'seller feedback, % positive'
  return 'stars from reviews'
}

/** "Amazon Germany" — the market words the pages use. */
export function whereWords(channel: string, market: string | null | undefined): string {
  const where = marketWords(market)
  return where ? `${channelWords(channel)} ${where}` : channelWords(channel)
}

// ── Bulk ─────────────────────────────────────────────────────────────

export const INSIGHT_BULK_MAX = 200
/** "Suggest fixes" asks the AI once per alert: at most this many alerts at a time (ruling 7). */
export const SUGGEST_MAX = 5

export class InsightsInputError extends Error {
  readonly statusCode = 400
}

/** `{ ids, action }` of a bulk bar: 1…200 distinct ids and one of `actions`. */
export function parseBulk<A extends string>(body: unknown, actions: readonly A[], max = INSIGHT_BULK_MAX): { ids: string[]; action: A } {
  const b = (body ?? {}) as { ids?: unknown; action?: unknown }
  const action = typeof b.action === 'string' ? b.action.trim().toLowerCase() : ''
  if (!(actions as readonly string[]).includes(action)) throw new InsightsInputError(`action: one of ${actions.join(', ')}.`)
  if (!Array.isArray(b.ids) || b.ids.length === 0) throw new InsightsInputError('ids: tick at least one row.')
  const ids = [...new Set(b.ids.filter((id): id is string => typeof id === 'string' && id.trim().length > 0 && id.length <= 64).map((id) => id.trim()))]
  if (ids.length === 0) throw new InsightsInputError('ids: tick at least one row.')
  if (ids.length > max) throw new InsightsInputError(`At most ${max} rows at once.`)
  return { ids, action: action as A }
}
