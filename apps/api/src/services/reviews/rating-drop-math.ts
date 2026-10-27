/**
 * Reviews › "Rating drop" alert (Phase 3, Settings › Alerts) — the pure rules. For each product family (a parent
 * product with its variants, or a product on its own) in each market, the average stars of the last 7 days against the
 * 28 days before them. The alert opens when both windows hold enough rated reviews and the average fell far enough.
 *
 *   Windows     recent = the last 7 days up to now; before = the 28 days before that (they never overlap).
 *   Sample      at least RATING_DROP_RULE.minRated rated reviews in EACH window, else it is noise.
 *   Threshold   the ONE "the rating dropped" rule (overviewMath.ts `isRatingDrop`, re-exported by review-rating.ts): the
 *               average fell RATING_DROP_STARS (0.3) stars or more — the Overview's products to watch, Insights ›
 *               Products' "Rating dropped" and this alert agree.
 *   Counts      the ONE rating calculation (review-rating.ts): only rows `countsAsStars` lets in — never seller feedback
 *               (eBay feedback, Amazon's 1–3 star seller feedback), an Amazon star only from a review a person imported
 *               (ruling 5: no Amazon API gives stars) — and never an eBay row (eBay's measure is % positive, never stars).
 *               The averages are `ratingOf(...).stars`. A review with no market belongs to no market, as in the
 *               complaint-spike check.
 *   Once        one alert per family and market until it is resolved: an open or acknowledged one stops a second; a
 *               resolved one stops a new one for RATING_DROP_RULE.reopenAfterDays (a new alert then needs the drop to
 *               be there in reviews written after it was resolved).
 *
 * The change is `delta` of the two `ratingOf` averages (two decimals). No database and no clock of its own:
 * every function takes `now`, so rating-drop.vitest.test.ts checks each rule with plain numbers. The hourly alerts check
 * runs it (rating-drop.service.ts), stores an alert as a ReviewSpike row with category RATING_DROP_CATEGORY.
 */
import { channelMarketLabel, delta, marketWords, ratingKindOf, round } from './overviewMath.js'
import { countsAsStars, isRatingDrop, RATING_DROP_STARS, ratingOf } from './review-rating.js'
import { FIXTURE_SOURCE, reviewKindOf } from './review-visibility.js'

/** `ReviewSpike.category` of a rating-drop alert (every other alert's category is a review theme). */
export const RATING_DROP_CATEGORY = 'RATING_DROP'

export const RATING_DROP_RULE = {
  /** The recent window, in days, ending now. */
  recentDays: 7,
  /** The window it is compared with: the days before the recent window. */
  beforeDays: 28,
  /** The fewest rated reviews in EACH window. */
  minRated: 5,
  /** The fewest stars the average must fall: the ONE rule's RATING_DROP_STARS (for the words; the check is `isRatingDrop`). */
  dropAtLeast: RATING_DROP_STARS,
  /** After a resolve, no new alert for the same family and market for this many days. */
  reopenAfterDays: 7,
} as const

export type RatingDropRule = { readonly [K in keyof typeof RATING_DROP_RULE]: number }

const DAY = 86_400_000

export interface RatingDropWindows {
  /** Start of the recent window (inclusive). */
  recentFrom: Date
  /** Start of the window before it (inclusive); it ends where the recent window starts. */
  beforeFrom: Date
  to: Date
}

export function ratingDropWindows(now: Date, rule: RatingDropRule = RATING_DROP_RULE): RatingDropWindows {
  const recentFrom = new Date(now.getTime() - rule.recentDays * DAY)
  return { recentFrom, beforeFrom: new Date(recentFrom.getTime() - rule.beforeDays * DAY), to: new Date(now.getTime()) }
}

/** Which window a review's date falls in; null = outside both (older, or later than now). */
export function windowOf(postedAt: Date, w: RatingDropWindows): 'recent' | 'before' | null {
  const t = postedAt.getTime()
  if (t > w.to.getTime() || t < w.beforeFrom.getTime()) return null
  return t >= w.recentFrom.getTime() ? 'recent' : 'before'
}

export interface RatingDropRow {
  productId: string | null
  channel: string
  marketplace: string | null
  rating: number | null
  kind?: string | null
  ingestSource: string | null
  postedAt: Date
  sentiment?: { label: string | null; topPhrases?: string[] | null } | null
}

/** Whether a review's stars count toward a rating drop, and why not. */
export function countsForRatingDrop(row: Omit<RatingDropRow, 'postedAt'>): { counts: true } | { counts: false; why: string } {
  if (row.rating == null || !Number.isFinite(row.rating) || row.rating < 1 || row.rating > 5) return { counts: false, why: 'no stars' }
  if (!row.productId) return { counts: false, why: 'no product' }
  if (!row.marketplace?.trim()) return { counts: false, why: 'no market' }
  if ((row.ingestSource ?? '').toUpperCase() === FIXTURE_SOURCE) return { counts: false, why: 'sample row' }
  // The ONE rating calculation decides (review-rating.ts); eBay's own measure is % positive, never stars.
  if (countsAsStars(row) && ratingKindOf(row.channel) === 'stars') return { counts: true }
  if (reviewKindOf(row.channel, row.kind) === 'seller') return { counts: false, why: 'seller feedback' }
  if (ratingKindOf(row.channel) !== 'stars') return { counts: false, why: 'no stars on this channel' }
  return { counts: false, why: 'Amazon stars only from imported reviews' }
}

export interface RatingDropStats {
  /** The family's own product id (the parent, or the product itself). */
  familyId: string
  market: string
  /** The channels whose reviews counted, sorted. */
  channels: string[]
  recentSum: number
  recentCount: number
  beforeSum: number
  beforeCount: number
  recentAvg: number | null
  beforeAvg: number | null
  /** recentAvg − beforeAvg, two decimals; null when either side has no rated review. */
  change: number | null
  /** Up to three short phrases from the recent window's low-star reviews. */
  phrases: string[]
}

/**
 * The two windows per family and market. `familyOf` maps a review's product to its family (null = the product is not
 * in the catalogue any more: the review is left out).
 */
export function ratingDropStats(rows: readonly RatingDropRow[], familyOf: (productId: string) => string | null, now: Date, rule: RatingDropRule = RATING_DROP_RULE): RatingDropStats[] {
  const w = ratingDropWindows(now, rule)
  const groups = new Map<string, { familyId: string; market: string; channels: Set<string>; recent: RatingDropRow[]; before: RatingDropRow[]; low: RatingDropRow[] }>()
  for (const row of rows) {
    if (!countsForRatingDrop(row).counts) continue
    const side = windowOf(row.postedAt, w)
    if (!side) continue
    const familyId = familyOf(row.productId!)
    if (!familyId) continue
    const market = row.marketplace!.trim().toUpperCase()
    const key = `${familyId}|${market}`
    const g = groups.get(key) ?? { familyId, market, channels: new Set<string>(), recent: [], before: [], low: [] }
    g.channels.add(row.channel.toUpperCase())
    g[side].push(row)
    if (side === 'recent' && (row.rating! <= 2 || row.sentiment?.label === 'NEGATIVE')) g.low.push(row)
    groups.set(key, g)
  }
  return [...groups.values()].map((g) => {
    // The ONE rating calculation (review-rating.ts): the same rows give the same stars as every Reviews page.
    const recent = ratingOf(g.recent)
    const before = ratingOf(g.before)
    const recentAvg = recent.stars
    const beforeAvg = before.stars
    const phrases: string[] = []
    for (const r of [...g.low].sort((a, b) => b.postedAt.getTime() - a.postedAt.getTime())) {
      for (const p of r.sentiment?.topPhrases ?? []) {
        const clean = p.replace(/\s+/g, ' ').trim()
        if (clean && !phrases.includes(clean) && phrases.length < 3) phrases.push(clean)
      }
    }
    return {
      familyId: g.familyId,
      market: g.market,
      channels: [...g.channels].sort(),
      recentSum: g.recent.reduce((n, r) => n + r.rating!, 0),
      recentCount: recent.starsFrom,
      beforeSum: g.before.reduce((n, r) => n + r.rating!, 0),
      beforeCount: before.starsFrom,
      recentAvg,
      beforeAvg,
      change: delta(recentAvg, beforeAvg, 2),
      phrases,
    }
  })
}

/**
 * Whether a family's market dropped: enough rated reviews in both windows and a fall by the ONE rule (`isRatingDrop`,
 * RATING_DROP_STARS or more).
 */
export function ratingDropVerdict(s: Pick<RatingDropStats, 'recentCount' | 'beforeCount' | 'change'>, rule: RatingDropRule = RATING_DROP_RULE): { drop: true } | { drop: false; why: string } {
  if (s.recentCount < rule.minRated) return { drop: false, why: `fewer than ${rule.minRated} rated reviews in the last ${rule.recentDays} days` }
  if (s.beforeCount < rule.minRated) return { drop: false, why: `fewer than ${rule.minRated} rated reviews in the ${rule.beforeDays} days before` }
  if (!isRatingDrop(s.change, 'stars')) return { drop: false, why: `the average fell less than ${RATING_DROP_STARS} stars` }
  return { drop: true }
}

export interface ExistingDropAlert {
  status: string
  resolvedAt: Date | null
}

/** Why no new alert opens for a family and market that dropped (null = a new one opens). */
export function ratingDropHeld(existing: readonly ExistingDropAlert[], now: Date, rule: RatingDropRule = RATING_DROP_RULE): 'open' | 'resolved recently' | null {
  if (existing.some((a) => a.status === 'OPEN' || a.status === 'ACKNOWLEDGED')) return 'open'
  const since = now.getTime() - rule.reopenAfterDays * DAY
  if (existing.some((a) => a.status === 'RESOLVED' && a.resolvedAt != null && a.resolvedAt.getTime() >= since)) return 'resolved recently'
  return null
}

// ── Words ───────────────────────────────────────────────────────────

/** A stored alert's numbers (ReviewSpike: sums of stars over rated reviews in each window). */
export interface StoredDrop {
  rate7dNumerator: number
  rate7dDenominator: number
  rate28dNumerator: number
  rate28dDenominator: number
}

/** The averages and the change of a stored alert (one decimal for the averages, two for the change). */
export function storedDropRating(s: StoredDrop): { before: number | null; now: number | null; change: number | null } {
  const now = s.rate7dDenominator > 0 ? s.rate7dNumerator / s.rate7dDenominator : null
  const before = s.rate28dDenominator > 0 ? s.rate28dNumerator / s.rate28dDenominator : null
  return { before: before == null ? null : round(before, 1), now: now == null ? null : round(now, 1), change: delta(now, before, 2) }
}

const stars = (n: number | null) => (n == null ? '—' : n.toFixed(1))

/** "Rating fell 0.5 stars". */
export function ratingDropTitle(s: StoredDrop): string {
  const { change } = storedDropRating(s)
  return change == null ? 'Rating fell' : `Rating fell ${Math.abs(change).toFixed(1)} ${Math.abs(change) === 1 ? 'star' : 'stars'}`
}

/** "6 rated reviews in 7 days · 22 in the 28 days before". */
export function ratingDropBasis(s: StoredDrop, rule: RatingDropRule = RATING_DROP_RULE): string {
  const n = s.rate7dDenominator
  return `${n} rated ${n === 1 ? 'review' : 'reviews'} in ${rule.recentDays} days · ${s.rate28dDenominator} in the ${rule.beforeDays} days before`
}

/** "3.9 stars in the last 7 days, was 4.4". */
export function ratingDropChangeWords(s: StoredDrop, rule: RatingDropRule = RATING_DROP_RULE): string {
  const r = storedDropRating(s)
  return `${stars(r.now)} stars in the last ${rule.recentDays} days, was ${stars(r.before)}`
}

/** Where an alert is: "Amazon Italy" with one channel, else the market ("Italy"). */
export function ratingDropWhere(market: string, channels: readonly string[]): string {
  return channels.length === 1 ? channelMarketLabel(channels[0], market) : (marketWords(market) ?? market)
}

/** The bell notice and e-mail of a new rating drop. */
export function ratingDropNoticeWords(input: StoredDrop & { productName: string | null; market: string; channels: readonly string[] }, rule: RatingDropRule = RATING_DROP_RULE): { title: string; body: string } {
  const where = ratingDropWhere(input.market, input.channels)
  const about = input.productName ? ` · ${input.productName}` : ''
  return {
    title: `${ratingDropTitle(input)} on ${where}${about}`,
    body: `${ratingDropChangeWords(input, rule)} (${ratingDropBasis(input, rule)}).`,
  }
}

/** Why a rating drop takes no "Suggest fixes" (the button's and the bulk bar's words). */
export const RATING_DROP_NO_SUGGEST = 'A rating drop names no single complaint: open the product and use Suggest a fix there.'
