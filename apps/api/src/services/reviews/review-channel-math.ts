/**
 * Reviews › channel pages (Amazon, eBay — 2026-10-26, build spec §3.5 / B18) — the pure rules behind
 * GET /api/reviews/area/channel (review-channel.service.ts): which channel, market and period an address asks for, where
 * Amazon gives review topics, how review requests split by Amazon's answer, which products to watch, how eBay feedback
 * splits by type, which eBay accounts serve a page and the order markets are listed in. No database, no clock of its
 * own, so review-channel.vitest.test.ts checks every rule with plain values.
 *
 * Amazon stars are only ever counted from reviews a person imported (ruling 5: no API gives Amazon's rating, average or
 * review count); eBay feedback is stored as 5 (positive), 3 (neutral) or 1 star (negative).
 */
import { averageRating, delta, parseOverviewPeriod, WATCH_MIN_RATINGS, type OverviewPeriod, type TrendBucket } from './overviewMath.js'
import type { ReasonKey } from './review-queue-words.js'

export type ReviewChannel = 'AMAZON' | 'EBAY'
export const CHANNEL_PAGES: readonly ReviewChannel[] = ['AMAZON', 'EBAY']

/** The channel of a page; anything else (Shopify and Etsy pages come later) → null. */
export function parseChannel(raw: unknown): ReviewChannel | null {
  const value = typeof raw === 'string' ? raw.trim().toUpperCase() : ''
  return (CHANNEL_PAGES as readonly string[]).includes(value) ? (value as ReviewChannel) : null
}

/** A market in an address: two letters, upper case; `GB` is the UK (as on the Listings pages). Anything else → null. */
export function parseMarket(raw: unknown): string | null {
  const value = typeof raw === 'string' ? raw.trim() : ''
  if (!/^[a-z]{2}$/i.test(value)) return null
  const code = value.toUpperCase()
  return code === 'GB' ? 'UK' : code
}

export type ChannelPeriod = Exclude<OverviewPeriod, 'all'>

/** 7 days, 30 days, 90 days or 12 months; anything else (All time included) is 30 days. */
export function parseChannelPeriod(raw: unknown): ChannelPeriod {
  const period = parseOverviewPeriod(raw)
  return period === 'all' ? '30d' : period
}

/** Imported Amazon reviews are few: 7 days per day, 30 and 90 days per week, 12 months per month. */
export function amazonBucket(period: ChannelPeriod): TrendBucket {
  return period === '7d' ? 'day' : period === '12m' ? 'month' : 'week'
}

/** The only Amazon review rows that carry stars Nexus shows: the ones a person imported from a file. */
export const IMPORTED_SOURCE = 'IMPORT_CSV'

// ── Amazon topics (Customer Feedback API) ────────────────────────────

/** Amazon gives review topics for these markets only (ruling 5): not Amazon.nl, not outside Europe's five. */
export const TOPIC_MARKETS: ReadonlySet<string> = new Set(['UK', 'DE', 'FR', 'IT', 'ES'])

export const TOPICS_WHERE_WORDS =
  'Amazon gives review topics for the UK, Germany, France, Italy and Spain only — not on Amazon.nl — weekly and in English, and Nexus needs the Selling Partner Insights role to read them.'

export type TopicsState = 'ok' | 'role_missing' | 'not_on_market' | 'none'

/**
 * Where topics stand for a page: not on this market, refused for the missing role (the newest read was refused), read
 * (some product has topics), or nothing read yet.
 */
export function topicsState(
  market: string | null,
  reads: ReadonlyArray<{ accessStatus: string; fetchedAt: Date }>,
): { state: TopicsState; weekOf: Date | null; lastOkAt: Date | null } {
  const ok = reads.filter(r => r.accessStatus === 'OK')
  const lastOkAt = ok.reduce<Date | null>((best, r) => (!best || r.fetchedAt > best ? r.fetchedAt : best), null)
  if (market && !TOPIC_MARKETS.has(market)) return { state: 'not_on_market', weekOf: null, lastOkAt: null }
  const newest = reads.reduce<{ accessStatus: string; fetchedAt: Date } | null>((best, r) => (!best || r.fetchedAt >= best.fetchedAt ? r : best), null)
  if (newest?.accessStatus === 'NEEDS_BRAND_ANALYTICS_ROLE') return { state: 'role_missing', weekOf: lastOkAt, lastOkAt }
  if (lastOkAt) return { state: 'ok', weekOf: mondayOf(lastOkAt), lastOkAt }
  return { state: 'none', weekOf: null, lastOkAt: null }
}

/** The Monday (UTC) of a date's week: topics are "the week of 20 Oct". */
export function mondayOf(at: Date): Date {
  const d = new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate()))
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7))
  return d
}

/** Words for a topics state (null when topics show). */
export function topicsWords(state: TopicsState, market: string | null, lastOkAt: Date | null): string | null {
  switch (state) {
    case 'ok': return null
    case 'not_on_market':
      return market === 'NL'
        ? 'Amazon gives no review topics on Amazon.nl.'
        : 'Amazon gives review topics for the UK, Germany, France, Italy and Spain only.'
    case 'role_missing':
      return `Amazon refused this week's read: Nexus needs the Selling Partner Insights role. ${lastOkAt ? 'The topics below are from the last read that worked.' : 'No topics show until the account owner adds the role in Seller Central and connects Amazon again.'}`
    case 'none':
      return 'No topics read yet. Amazon updates them weekly, per product, once a product has enough reviews.'
  }
}

// ── Amazon requests by Amazon's answer ───────────────────────────────

export interface AmazonRequestCounts {
  /** Amazon accepted: it sends its own email. */
  sent: number
  /** Amazon said "too early": tried again every day until day 30. */
  tooEarly: number
  /** Asked before for this order (from Seller Central or by Nexus). */
  alreadyAsked: number
  /** Amazon said no, or Amazon's day 30 passed. */
  notAllowed: number
  /** Amazon did not answer. */
  failed: number
  /** Left out by a rule, the "How was it?" check or a person. */
  skipped: number
  /** Waiting for their first try. */
  waiting: number
}

const REQUEST_BUCKET: Partial<Record<ReasonKey, keyof AmazonRequestCounts>> = {
  sent_amazon: 'sent',
  amazon_too_early: 'tooEarly',
  already_asked: 'alreadyAsked',
  amazon_refused: 'notAllowed',
  window_closed: 'notAllowed',
  amazon_no_answer: 'failed',
  first_try_waits: 'waiting',
  due_now: 'waiting',
  check_sent: 'waiting',
}

/** Requests by Amazon's answer: each row's reason (review-queue-words.ts `reasonKeyOf`) into one of the buckets. */
export function amazonRequestCounts(reasons: readonly ReasonKey[]): AmazonRequestCounts {
  const out: AmazonRequestCounts = { sent: 0, tooEarly: 0, alreadyAsked: 0, notAllowed: 0, failed: 0, skipped: 0, waiting: 0 }
  for (const key of reasons) out[REQUEST_BUCKET[key] ?? 'skipped'] += 1
  return out
}

// ── Amazon products to watch (imported stars only) ───────────────────

export interface WatchInput {
  productId: string
  /** Stars of the product's imported reviews in the period, and in the period before. */
  now: ReadonlyArray<number | null>
  before: ReadonlyArray<number | null>
  /** The product has Amazon topics on this market. */
  hasTopics: boolean
}

export interface WatchRank {
  productId: string
  ratingNow: number | null
  ratingBefore: number | null
  /** Only with at least WATCH_MIN_RATINGS imported ratings on each side; else null (noise). */
  change: number | null
  imported: number
}

/**
 * Amazon products to watch: the biggest drop in imported stars first, then the lowest rating, then the most imported
 * reviews; a product with topics but no imported review comes last ("No rating data from Amazon — import reviews").
 */
export function rankAmazonWatch(rows: readonly WatchInput[], limit = 8, minRatings = WATCH_MIN_RATINGS): WatchRank[] {
  const ranked = rows
    .filter(r => r.now.length > 0 || r.hasTopics)
    .map(r => {
      const rated = r.now.filter((x): x is number => x != null)
      const ratedBefore = r.before.filter((x): x is number => x != null)
      const now = averageRating(rated)
      const before = averageRating(ratedBefore)
      return {
        productId: r.productId,
        ratingNow: now == null ? null : Math.round(now * 10) / 10,
        ratingBefore: before == null ? null : Math.round(before * 10) / 10,
        change: rated.length >= minRatings && ratedBefore.length >= minRatings ? delta(now, before, 1) : null,
        imported: r.now.length,
      }
    })
  const big = Number.POSITIVE_INFINITY
  ranked.sort((a, b) =>
    (a.change ?? big) - (b.change ?? big)
    || (a.ratingNow ?? big) - (b.ratingNow ?? big)
    || b.imported - a.imported
    || a.productId.localeCompare(b.productId))
  return ranked.slice(0, limit)
}

// ── eBay ─────────────────────────────────────────────────────────────

export interface FeedbackTypeCounts {
  positive: number
  neutral: number
  negative: number
}

/** Stored eBay feedback (5 / 3 / 1 star) by type. A rating of 4 counts as positive, 2 as negative; none is left out. */
export function feedbackTypeCounts(ratings: ReadonlyArray<number | null | undefined>): FeedbackTypeCounts {
  const out = { positive: 0, neutral: 0, negative: 0 }
  for (const r of ratings) {
    if (r == null) continue
    if (r >= 4) out.positive += 1
    else if (r <= 2) out.negative += 1
    else out.neutral += 1
  }
  return out
}

export interface EbayAccount {
  id: string
  /** The connection's market; null = one sign-in for every eBay site (the usual eBay account). */
  market: string | null
  isPrimary: boolean
}

/**
 * Which eBay accounts a page reads eBay's summary from. A market page: the account of that market, else the account that
 * serves every site (`accountWide`: eBay's numbers are then the whole account's, not this market's). All markets: every
 * account.
 */
export function pageAccounts(accounts: readonly EbayAccount[], market: string | null): { accounts: EbayAccount[]; accountWide: boolean } {
  if (!market) return { accounts: [...accounts], accountWide: false }
  const own = accounts.filter(a => a.market === market)
  if (own.length > 0) return { accounts: own, accountWide: false }
  const wide = accounts.filter(a => a.market == null)
  const pick = wide.find(a => a.isPrimary) ?? wide[0]
  return pick ? { accounts: [pick], accountWide: true } : { accounts: [], accountWide: false }
}

// ── Markets ──────────────────────────────────────────────────────────

const MARKET_ORDER = ['IT', 'DE', 'FR', 'ES', 'UK', 'NL', 'SE', 'PL', 'BE', 'IE', 'AT', 'CH', 'TR', 'US', 'CA', 'MX', 'BR', 'JP', 'AU']

/** Markets as the menu lists them: Italy, Germany, France, Spain, the UK … then the rest A–Z. Two letters only. */
export function orderMarkets(codes: Iterable<string | null | undefined>): string[] {
  const set = new Set<string>()
  for (const raw of codes) {
    const code = parseMarket(raw)
    if (code) set.add(code)
  }
  const rank = (c: string) => {
    const i = MARKET_ORDER.indexOf(c)
    return i === -1 ? MARKET_ORDER.length : i
  }
  return [...set].sort((a, b) => rank(a) - rank(b) || a.localeCompare(b))
}
