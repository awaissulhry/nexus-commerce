/**
 * RatingBars — the pure rules (Reviews parts, 2026-10-26). No React, so Node tests cover them.
 *
 * Rows run 5 stars first. A bar is a filter: pressing a bar picks its stars, pressing the pressed bar clears the filter.
 * A bar with no ratings is HELD (it filters to nothing) and says why. Percentages are whole numbers that add up to 100:
 * each is rounded down, and the points left over go to the largest remainders (more stars first on a tie), so a strip
 * of five never reads 99 % or 101 %.
 */

export type RatingStars = 1 | 2 | 3 | 4 | 5

/** Ratings per star, 5 stars FIRST: `[five, four, three, two, one]`. */
export type RatingCounts = readonly [number, number, number, number, number]

export interface RatingBarRow {
  stars: RatingStars
  count: number
  /** Whole percent of all ratings; the five add up to 100 (0 when there are none). */
  pct: number
  /** The bar's accessible name: "5 stars: 82 ratings, 64%". */
  label: string
  /** Why the bar is held (no ratings with these stars), or null when it filters. */
  heldReason: string | null
}

const STARS: readonly RatingStars[] = [5, 4, 3, 2, 1]

function clean(n: number): number {
  return Number.isFinite(n) && n > 0 ? Math.round(n) : 0
}

export function ratingTotal(counts: RatingCounts): number {
  return counts.reduce<number>((sum, n) => sum + clean(n), 0)
}

/** Whole percentages that add up to 100 (largest remainder); all zero when there are no ratings. */
export function ratingPercents(counts: RatingCounts): number[] {
  const values = counts.map(clean)
  const total = values.reduce((a, b) => a + b, 0)
  if (total === 0) return values.map(() => 0)
  const exact = values.map(n => (n / total) * 100)
  const pct = exact.map(Math.floor)
  let left = 100 - pct.reduce((a, b) => a + b, 0)
  const order = exact.map((x, i) => ({ i, rest: x - Math.floor(x) })).sort((a, b) => b.rest - a.rest || a.i - b.i)
  for (const { i } of order) {
    if (left <= 0) break
    pct[i] += 1
    left -= 1
  }
  return pct
}

export function starsWord(stars: number): string {
  return `${stars} ${stars === 1 ? 'star' : 'stars'}`
}

/** "No 3-star ratings to show" — the default reason a bar with no ratings is held. */
export function defaultZeroReason(stars: RatingStars): string {
  return `No ${stars}-star ratings to show`
}

export function ratingBarRows(counts: RatingCounts, zeroReason: (stars: RatingStars) => string = defaultZeroReason): RatingBarRow[] {
  const pct = ratingPercents(counts)
  return STARS.map((stars, i) => {
    const count = clean(counts[i])
    return {
      stars,
      count,
      pct: pct[i],
      label: `${starsWord(stars)}: ${count.toLocaleString('en-US')} ${count === 1 ? 'rating' : 'ratings'}, ${pct[i]}%`,
      heldReason: count === 0 ? zeroReason(stars) : null,
    }
  })
}

/** The filter after a bar is pressed: its stars, or `null` when it was the pressed one. A held bar changes nothing. */
export function nextRatingFilter(current: RatingStars | null | undefined, pressed: RatingStars, held = false): RatingStars | null {
  if (held) return current ?? null
  return current === pressed ? null : pressed
}
