/**
 * Reviews Overview — the pure arithmetic behind GET /api/reviews/area/overview (review-overview.service.ts): the dates a
 * period covers and the period before it, the chart's buckets, weighted averages, deltas, star spreads, eBay's share of
 * positive feedback, review rates, star impact and the "products to watch" ranking. No database, no clock of its own
 * (every function takes `now`), so review-overview.vitest.test.ts checks every rule with plain numbers.
 */

export const OVERVIEW_PERIODS = ['7d', '30d', '90d', '12m', 'all'] as const
export type OverviewPeriod = (typeof OVERVIEW_PERIODS)[number]
export const DEFAULT_OVERVIEW_PERIOD: OverviewPeriod = '30d'

/** A period from the query string; anything else is the default (30 days). */
export function parseOverviewPeriod(raw: unknown): OverviewPeriod {
  const value = typeof raw === 'string' ? raw.trim().toLowerCase() : ''
  return (OVERVIEW_PERIODS as readonly string[]).includes(value) ? (value as OverviewPeriod) : DEFAULT_OVERVIEW_PERIOD
}

export interface PeriodBounds {
  /** Start of the period; null for All time. */
  from: Date | null
  to: Date
  /** The period before it, of the same length; null for All time. */
  prevFrom: Date | null
  prevTo: Date | null
}

const DAY = 86_400_000

function monthsBefore(date: Date, months: number): Date {
  const d = new Date(date.getTime())
  const day = d.getUTCDate()
  d.setUTCDate(1)
  d.setUTCMonth(d.getUTCMonth() - months)
  const lastDay = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate()
  d.setUTCDate(Math.min(day, lastDay))
  return d
}

/** The dates a period covers, ending at `now`, and the period before it (same rule as the web's reviewsPeriod.ts). */
export function periodBounds(period: OverviewPeriod, now: Date): PeriodBounds {
  const to = new Date(now.getTime())
  if (period === 'all') return { from: null, to, prevFrom: null, prevTo: null }
  if (period === '12m') {
    const from = monthsBefore(to, 12)
    return { from, to, prevFrom: monthsBefore(to, 24), prevTo: from }
  }
  const days = period === '7d' ? 7 : period === '30d' ? 30 : 90
  const from = new Date(to.getTime() - days * DAY)
  return { from, to, prevFrom: new Date(from.getTime() - days * DAY), prevTo: from }
}

/** Which period a date falls in: the current one, the one before it, or neither. */
export function periodOf(at: Date, bounds: PeriodBounds): 'now' | 'prev' | null {
  const t = at.getTime()
  if (t > bounds.to.getTime()) return null
  if (bounds.from == null || t >= bounds.from.getTime()) return 'now'
  if (bounds.prevFrom != null && t >= bounds.prevFrom.getTime()) return 'prev'
  return null
}

// ── The chart's buckets ──────────────────────────────────────────────

export type TrendBucket = 'day' | 'week' | 'month'

/** 7 and 30 days draw a point per day, 90 days per week, 12 months and All time per month. */
export function trendBucket(period: OverviewPeriod): TrendBucket {
  return period === '7d' || period === '30d' ? 'day' : period === '90d' ? 'week' : 'month'
}

/** The bucket a date belongs to: `2026-10-26` (day), the Monday of its week (week), `2026-10` (month). UTC. */
export function bucketKey(at: Date, bucket: TrendBucket): string {
  if (bucket === 'month') return at.toISOString().slice(0, 7)
  if (bucket === 'day') return at.toISOString().slice(0, 10)
  const monday = new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate()))
  monday.setUTCDate(monday.getUTCDate() - ((monday.getUTCDay() + 6) % 7))
  return monday.toISOString().slice(0, 10)
}

/** Every bucket from `from` to `to`, oldest first, so a day without reviews draws a 0, never a gap in the count. */
export function bucketKeys(from: Date, to: Date, bucket: TrendBucket): string[] {
  const keys: string[] = []
  const seen = new Set<string>()
  const cursor = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), bucket === 'month' ? 1 : from.getUTCDate()))
  // Safety stop: at most ~800 buckets (All time per month over 60 years).
  for (let i = 0; i < 800 && cursor.getTime() <= to.getTime(); i++) {
    const key = bucketKey(cursor, bucket)
    if (!seen.has(key)) {
      seen.add(key)
      keys.push(key)
    }
    if (bucket === 'month') cursor.setUTCMonth(cursor.getUTCMonth() + 1)
    else cursor.setUTCDate(cursor.getUTCDate() + (bucket === 'week' ? 7 : 1))
  }
  const last = bucketKey(to, bucket)
  if (!seen.has(last)) keys.push(last)
  return keys
}

export interface TrendPoint {
  /** The bucket key (see `bucketKey`). */
  day: string
  reviews: number
  /** Average stars of the rated reviews in the bucket; null when none was rated (a gap in the line, never 0). */
  avg: number | null
}

/** Reviews per bucket and their average rating. */
export function trendPoints(rows: ReadonlyArray<{ postedAt: Date; rating: number | null }>, keys: readonly string[], bucket: TrendBucket): TrendPoint[] {
  const acc = new Map<string, { reviews: number; sum: number; rated: number }>(keys.map(k => [k, { reviews: 0, sum: 0, rated: 0 }]))
  for (const row of rows) {
    const slot = acc.get(bucketKey(row.postedAt, bucket))
    if (!slot) continue
    slot.reviews += 1
    if (row.rating != null) {
      slot.sum += row.rating
      slot.rated += 1
    }
  }
  return keys.map(day => {
    const slot = acc.get(day)!
    return { day, reviews: slot.reviews, avg: slot.rated > 0 ? round(slot.sum / slot.rated, 2) : null }
  })
}

// ── Averages and changes ─────────────────────────────────────────────

export function round(n: number, digits = 1): number {
  const f = 10 ** digits
  return Math.round(n * f) / f
}

/** The average of `value`s weighted by `weight` (a weight ≤ 0 or a missing value is left out). Nothing to weigh → null. */
export function weightedAverage(items: ReadonlyArray<{ value: number | null | undefined; weight: number | null | undefined }>): number | null {
  let sum = 0
  let total = 0
  for (const item of items) {
    const w = item.weight ?? 0
    if (item.value == null || !Number.isFinite(item.value) || !(w > 0)) continue
    sum += item.value * w
    total += w
  }
  return total > 0 ? sum / total : null
}

/** The plain average of the ratings that exist; none → null. */
export function averageRating(ratings: ReadonlyArray<number | null | undefined>): number | null {
  return weightedAverage(ratings.map(value => ({ value, weight: 1 })))
}

/** `now − before`, rounded; null when either side is unknown (a change is never invented from nothing). */
export function delta(now: number | null | undefined, before: number | null | undefined, digits = 1): number | null {
  if (now == null || before == null || !Number.isFinite(now) || !Number.isFinite(before)) return null
  return round(now - before, digits)
}

/** Ratings per star, 5 stars first: `[five, four, three, two, one]`. A rating is rounded to the nearest whole star. */
export function starCounts(ratings: ReadonlyArray<number | null | undefined>): [number, number, number, number, number] {
  const counts: [number, number, number, number, number] = [0, 0, 0, 0, 0]
  for (const r of ratings) {
    if (r == null || !Number.isFinite(r)) continue
    const star = Math.min(5, Math.max(1, Math.round(r)))
    counts[5 - star] += 1
  }
  return counts
}

/**
 * eBay's measure: positive feedback as a share of positive + negative (neutral is left out, as on eBay), in percent with
 * one decimal. eBay feedback is stored as 5 (positive), 3 (neutral) or 1 star (negative). None counted → null.
 */
export function positiveShare(ratings: ReadonlyArray<number | null | undefined>): number | null {
  let positive = 0
  let negative = 0
  for (const r of ratings) {
    if (r == null) continue
    if (r >= 4) positive += 1
    else if (r <= 2) negative += 1
  }
  return positive + negative > 0 ? round((positive / (positive + negative)) * 100, 1) : null
}

export type RatingKind = 'stars' | 'positive'

/** eBay seller feedback reads as "% positive"; every other channel as stars. */
export function ratingKindOf(channel: string): RatingKind {
  return channel.toUpperCase() === 'EBAY' ? 'positive' : 'stars'
}

/** The rating of a set of reviews in its channel's measure (stars to one decimal, or % positive). */
export function ratingIn(kind: RatingKind, ratings: ReadonlyArray<number | null | undefined>): number | null {
  if (kind === 'positive') return positiveShare(ratings)
  const avg = averageRating(ratings)
  return avg == null ? null : round(avg, 2)
}

/** Reviews that followed a request, per request sent (0…1); nothing sent → null. */
export function reviewRate(sent: number, followed: number): number | null {
  return sent > 0 ? Math.min(1, followed / sent) : null
}

/** How far the average rating of the reviews that mention a theme sits from the overall average (stars). */
export function starImpact(avgWithTheme: number | null, overall: number | null): number | null {
  return delta(avgWithTheme, overall, 1)
}

// ── Products to watch ────────────────────────────────────────────────

/** The fewest rated reviews in EACH period before a change counts: fewer and the change is noise. */
export const WATCH_MIN_RATINGS = 3

export interface WatchCandidate {
  key: string
  ratingNow: number | null
  ratingBefore: number | null
  countNow: number
  countBefore: number
  kind: RatingKind
}

/**
 * The biggest rating drops first. Only real drops count (change < 0), and only with at least WATCH_MIN_RATINGS rated
 * reviews in both periods. A change in "% positive" points is put on the star scale (÷ 20: 100 points = 5 stars) only to
 * rank it beside star drops; each row keeps its own measure.
 */
export function rankWatch<T extends WatchCandidate>(rows: readonly T[], limit = 5, minRatings = WATCH_MIN_RATINGS): Array<T & { change: number }> {
  const out: Array<T & { change: number; score: number }> = []
  for (const row of rows) {
    if (row.countNow < minRatings || row.countBefore < minRatings) continue
    const change = delta(row.ratingNow, row.ratingBefore, 1)
    if (change == null || change >= 0) continue
    out.push({ ...row, change, score: row.kind === 'positive' ? change / 20 : change })
  }
  out.sort((a, b) => a.score - b.score || b.countNow - a.countNow || a.key.localeCompare(b.key))
  return out.slice(0, limit).map(({ score: _score, ...row }) => row as T & { change: number })
}

/** The last `count` buckets of `size` days ending at `now` (oldest first): the watch list's six-week sparkline. */
export function sparkWindows(now: Date, count = 6, sizeDays = 7): Array<{ from: Date; to: Date }> {
  const out: Array<{ from: Date; to: Date }> = []
  for (let i = count - 1; i >= 0; i--) {
    const to = new Date(now.getTime() - i * sizeDays * DAY)
    out.push({ from: new Date(to.getTime() - sizeDays * DAY), to })
  }
  return out
}

/** A sparkline needs this many readings; fewer and the row says "Too few to trend". */
export const SPARK_MIN_POINTS = 3

/** Readings per window in the row's measure; a window with no rated review is null (a break in the line). */
export function sparkValues(
  kind: RatingKind,
  rows: ReadonlyArray<{ postedAt: Date; rating: number | null }>,
  windows: ReadonlyArray<{ from: Date; to: Date }>,
): { values: Array<number | null>; tooFew: boolean } {
  const values = windows.map(w => {
    const inside = rows.filter(r => r.postedAt.getTime() > w.from.getTime() && r.postedAt.getTime() <= w.to.getTime())
    const value = ratingIn(kind, inside.map(r => r.rating))
    return value == null ? null : round(value, 1)
  })
  return { values, tooFew: values.filter(v => v != null).length < SPARK_MIN_POINTS }
}

// ── Words ────────────────────────────────────────────────────────────

const COUNTRY: Record<string, string> = {
  IT: 'Italy', DE: 'Germany', FR: 'France', ES: 'Spain', UK: 'United Kingdom', GB: 'United Kingdom', NL: 'Netherlands',
  SE: 'Sweden', PL: 'Poland', BE: 'Belgium', AT: 'Austria', CH: 'Switzerland', IE: 'Ireland', TR: 'Turkey',
  US: 'United States', CA: 'Canada', MX: 'Mexico', JP: 'Japan', AU: 'Australia',
}

/** Review themes (ReviewSentiment.categories) in the words every Reviews page uses (web: _lib/reviewWords.ts). */
const THEME: Record<string, string> = {
  FIT_SIZING: 'Fit & sizing', DURABILITY: 'Durability', SHIPPING: 'Shipping', VALUE: 'Value', DESIGN: 'Design',
  QUALITY: 'Quality', SAFETY: 'Safety', COMFORT: 'Comfort', OTHER: 'Other',
}

export function themeWords(key: string): string {
  return THEME[key] ?? key
}

const CHANNEL: Record<string, string> = { AMAZON: 'Amazon', EBAY: 'eBay', SHOPIFY: 'Shopify', ETSY: 'Etsy', WOOCOMMERCE: 'WooCommerce' }

export function marketWords(code: string | null | undefined): string | null {
  const c = code?.trim().toUpperCase()
  if (!c) return null
  return COUNTRY[c] ?? c
}

export function channelWords(channel: string | null | undefined): string {
  const c = (channel ?? '').toUpperCase()
  return CHANNEL[c] ?? (c ? c.charAt(0) + c.slice(1).toLowerCase() : 'Unknown channel')
}

/** "Amazon Germany", "eBay Italy", "Shopify". */
export function channelMarketLabel(channel: string, market: string | null | undefined): string {
  const where = marketWords(market)
  return where ? `${channelWords(channel)} ${where}` : channelWords(channel)
}

/** "Paolo G." from a buyer's name; nothing usable → null. */
export function buyerShort(name: string | null | undefined): string | null {
  const parts = (name ?? '').trim().split(/\s+/).filter(Boolean)
  if (parts.length === 0) return null
  if (parts.length === 1) return parts[0]
  return `${parts[0]} ${parts[parts.length - 1].charAt(0).toUpperCase()}.`
}

/** A review's text cut to a quote: "“Runs small, order one size up”". */
export function quoteOf(text: string | null | undefined, max = 90): string | null {
  const clean = (text ?? '').replace(/\s+/g, ' ').trim()
  if (!clean) return null
  return `“${clean.length > max ? `${clean.slice(0, max - 1).trimEnd()}…` : clean}”`
}

/** Whole days between two dates (floor), never negative. */
export function daysBetween(earlier: Date, later: Date): number {
  return Math.max(0, Math.floor((later.getTime() - earlier.getTime()) / DAY))
}
