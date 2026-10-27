/**
 * Reviews — the ONE rating (Owner, 2026-10-27; audit C3, B13; build spec ruling 5). Every page that shows a rating —
 * the Overview's tile, trend, spread and channel table, the Amazon and eBay pages, Insights › Products, the product
 * studio's Reviews card and the daily digest — counts it here, so the same reviews give the same number everywhere:
 *
 *   - Stars: product reviews only. Amazon's stars come only from reviews a person imported (no API gives Amazon's
 *     rating, average or count); the licensed review feed and Amazon's seller feedback never count as stars.
 *   - eBay seller feedback reads as "% positive" (positive of positive + negative, neutral left out, as eBay counts it),
 *     never as stars.
 *   - Amazon's seller feedback holds only 1–3 star feedback: it is counted and listed, never averaged.
 * The words say where the number comes from ("Amazon: from imported reviews"). Pure: no database, no clock.
 */
import { averageRating, positiveShare, round } from './overviewMath.js'
import { isImportedSource, reviewKindOf } from './review-visibility.js'

export type RatingMeasure = 'stars' | 'positive'

/** What the rating reads of one review row. */
export interface RatingRow {
  channel: string
  kind?: string | null
  ingestSource?: string | null
  rating: number | null
}

/** How a row counts: as stars, as eBay's "% positive", or not at all (null). */
export function ratingMeasureOf(row: Pick<RatingRow, 'channel' | 'kind' | 'ingestSource'>): RatingMeasure | null {
  const channel = row.channel.toUpperCase()
  if (reviewKindOf(channel, row.kind) === 'seller') return channel === 'EBAY' ? 'positive' : null
  if (channel === 'AMAZON' && !isImportedSource(row.ingestSource)) return null
  return 'stars'
}

/** Rows whose stars count in an average, a trend or a spread. */
export function countsAsStars(row: Pick<RatingRow, 'channel' | 'kind' | 'ingestSource'>): boolean {
  return ratingMeasureOf(row) === 'stars'
}

export interface Rating {
  /** Average stars (two decimals); null when no star rating counts. */
  stars: number | null
  /** Rated reviews the stars come from. */
  starsFrom: number
  /** eBay's % positive (one decimal); null when no eBay feedback counts. */
  positive: number | null
  /** eBay feedback (positive or negative) the share comes from. */
  positiveFrom: number
  /** Some of the stars are Amazon's, from imported reviews. */
  amazonImported: boolean
  /** Where the number comes from, in words: "4.3 stars from 12 reviews (Amazon: from imported reviews)". */
  words: string
  /** The stars' source in a few words, for a tile's hint: "12 reviews · Amazon: from imported reviews". */
  starsSource: string
}

const plural = (n: number, one: string, many: string) => `${n.toLocaleString('en')} ${n === 1 ? one : many}`

/** The rating of a set of reviews. Pure. */
export function ratingOf(rows: readonly RatingRow[]): Rating {
  const stars: number[] = []
  const feedback: number[] = []
  let amazonImported = false
  let amazonUnrated = false
  for (const row of rows) {
    const measure = ratingMeasureOf(row)
    if (measure == null) {
      if (row.channel.toUpperCase() === 'AMAZON' && reviewKindOf(row.channel, row.kind) === 'product') amazonUnrated = true
      continue
    }
    if (row.rating == null || !Number.isFinite(row.rating)) continue
    if (measure === 'stars') {
      stars.push(row.rating)
      if (row.channel.toUpperCase() === 'AMAZON') amazonImported = true
    } else feedback.push(row.rating)
  }
  const avg = averageRating(stars)
  const positive = positiveShare(feedback)
  const positiveFrom = feedback.filter((r) => r >= 4 || r <= 2).length
  const parts: string[] = []
  if (avg != null) parts.push(`${avg.toFixed(1)} stars from ${plural(stars.length, 'review', 'reviews')}${amazonImported ? ' (Amazon: from imported reviews)' : ''}`)
  if (positive != null) parts.push(`${positive.toFixed(1)}% positive from ${plural(positiveFrom, 'eBay feedback', 'eBay feedback')}`)
  const words = parts.length
    ? parts.join(' · ')
    : amazonUnrated ? 'No rating data from Amazon — import reviews' : 'No rating yet'
  const starsSource = avg == null
    ? (amazonUnrated ? 'No rating data from Amazon — import reviews' : 'No star ratings yet')
    : `${plural(stars.length, 'review', 'reviews')}${amazonImported ? ' · Amazon: from imported reviews' : ''}`
  return { stars: avg == null ? null : round(avg, 2), starsFrom: stars.length, positive, positiveFrom, amazonImported, words, starsSource }
}

/** The rating in one channel's measure (eBay: % positive, every other channel: stars), or null. Pure. */
export function ratingInMeasure(rows: readonly RatingRow[], measure: RatingMeasure): number | null {
  const r = ratingOf(rows)
  return measure === 'positive' ? r.positive : r.stars
}

// The one rule for "the rating dropped" (audit C8) lives with the arithmetic (overviewMath.ts), re-exported here.
export { RATING_DROP_POINTS, RATING_DROP_STARS, isRatingDrop } from './overviewMath.js'
