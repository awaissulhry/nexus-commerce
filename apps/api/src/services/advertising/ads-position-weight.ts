/**
 * ACR.2.2b — the position-weighting math, as pure functions.
 *
 * Extracted from `ads-coverage.service.ts` so the arithmetic behind the number an operator
 * reads can be tested without a database. The formula is small; what needs pinning is not the
 * multiplication but the NULL discipline around it, because every failure mode of this feature
 * is a number that means "we could not see" being rendered as a number that means "zero".
 *
 * ── The weight ──────────────────────────────────────────────────────────────────────────────
 * A percentage point of share at the top of the page is worth more than one further down. How
 * much more is measurable from our own placement report rather than borrowed from an industry
 * CTR-decay table: the ratio of our rest-of-search CTR to our top-of-search CTR. Measured
 * IT/90d on 2026-08-05 — top 3.784%, rest 0.482% — the ratio is **0.127**.
 *
 * Detail-page placements are excluded upstream: they are not a SERP, and their 0.067% CTR
 * would drag the ratio toward a number describing a different surface entirely.
 */

/** Used only when the account has too little placement traffic to measure its own ratio. */
export const FALLBACK_REST_WEIGHT = 0.2

export interface PlacementCounts {
  topImpressions: number
  topClicks: number
  restImpressions: number
  restClicks: number
}

export interface ResolvedWeight {
  restWeight: number
  topCtr: number | null
  restCtr: number | null
  basis: 'measured' | 'fallback'
}

/**
 * The account's own rest:top CTR ratio.
 *
 * Guarded on CLICKS, not impressions. Impressions with zero clicks would compute a ratio of
 * exactly 0 and silently declare every rest-of-search impression worthless — a measured-looking
 * zero produced by absence of data, which is the one thing this module exists to prevent.
 * Clamped to 1: a rest slot outperforming a top slot is a data artefact, not a reason to score
 * bottom-of-page presence above the top.
 */
export function resolveRestWeight(c: PlacementCounts): ResolvedWeight {
  const topCtr = c.topImpressions > 0 ? c.topClicks / c.topImpressions : null
  const restCtr = c.restImpressions > 0 ? c.restClicks / c.restImpressions : null
  const measurable = topCtr != null && restCtr != null && topCtr > 0 && c.topClicks > 0
  return {
    restWeight: measurable ? Math.min(1, restCtr / topCtr) : FALLBACK_REST_WEIGHT,
    topCtr,
    restCtr,
    basis: measurable ? 'measured' : 'fallback',
  }
}

/**
 * Fraction of our paid SEARCH impressions that sat in top-of-search.
 * `null` when we bought no search impressions at all — never 0, which would assert we bought
 * impressions and none of them reached the top.
 */
export function topMixOf(topImpressions: number, restImpressions: number): number | null {
  const total = topImpressions + restImpressions
  return total > 0 ? topImpressions / total : null
}

/**
 * The multiplier applied to share: 1.0 if every impression is top-of-search, `restWeight` if
 * none is, linear between. Pure.
 */
export function positionMultiplier(topMix: number, restWeight: number): number {
  return topMix + (1 - topMix) * restWeight
}

export type PositionBasis = 'measured' | 'no-paid-impressions' | 'no-holding-campaign' | 'unmeasured-week'

/**
 * Why a row has no position-weighted score — resolved BEFORE the score, so that every null on
 * the board carries a reason an operator can read.
 *
 * Order matters: an unmeasured week outranks everything (the share itself is unknown, so a
 * position on it would be meaningless), then "we do not bid this term at all" — whose presence
 * is organic and whose page position we genuinely cannot observe — then "we bid it but bought
 * no search impressions in the window".
 */
export function resolvePositionBasis(args: {
  share: number | null
  hasHoldingCampaign: boolean
  topMix: number | null
}): PositionBasis {
  if (args.share == null) return 'unmeasured-week'
  if (!args.hasHoldingCampaign) return 'no-holding-campaign'
  if (args.topMix == null) return 'no-paid-impressions'
  return 'measured'
}

/**
 * Share re-expressed in top-of-search-equivalent units, or null with a reason.
 *
 * Returns null on every non-'measured' basis rather than falling back to the share itself or to
 * a rest-of-search assumption. A term we do not bid would otherwise be scored as though all its
 * organic presence sat at the bottom of the page, which is a guess wearing a measurement's
 * formatting.
 */
export function positionWeightedScore(args: {
  share: number | null
  topMix: number | null
  restWeight: number
  basis: PositionBasis
}): number | null {
  if (args.basis !== 'measured' || args.share == null || args.topMix == null) return null
  return args.share * positionMultiplier(args.topMix, args.restWeight)
}
