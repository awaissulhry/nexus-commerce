import { Decimal } from 'decimal.js'
import type { Issue } from '../../core/errors'
import { minorPlaces, type CurrencyCode } from '../../core/money'
import { decimalText } from '../../product/units/units'
import { six } from '../sheet-components/rules'

/**
 * The size-run weighted cost and size surcharges (B-W2b-420; FIN-016; design products.styles › Cost "Cost by size": "Rows:
 * materials, labour, total · one column per size (base size marked) · suggested size surcharge for big sizes"), pure.
 *
 *   weights     a style's typical size mix: its own for the season, else its own for every season (SizeWeight rows,
 *               relative weights), else the size curve the sheet names (SizeCurve.shares, percents totalling 100); what was
 *               used is kept on the sheet (CostSheet.sizeWeights)
 *   weighted    Σ cost of a size × its weight ÷ Σ weights, over the sizes weighted (6 places); null while a weighted size
 *               misses an input
 *   surcharges  each size after the base size in the range whose cost is at least SURCHARGE_FROM_PCT above the base size's:
 *               the extra cost, its percent of the base cost, and — when the sheet has a target margin — the price
 *               surcharge that keeps that margin (extra ÷ (1 − margin), rounded up to the currency's minor unit). A
 *               suggestion only: the style's surcharges are kept by sales (PUT /sales/styles/:styleId/size-surcharges).
 */

export const WEIGHT_SOURCES = ['SEASON', 'EVERY_SEASON', 'SIZE_CURVE', 'NONE'] as const
export type WeightSource = (typeof WEIGHT_SOURCES)[number]

/** A size whose cost is at least this percent above the base size's gets a surcharge suggested. */
export const SURCHARGE_FROM_PCT = '2'

export const WEIGHT_LIMITS = Object.freeze({ sizes: 100, max: '99999.9999' })

/** The database's key of one size's weight of a style (per season, or every season). */
export const sizeWeightKey = (styleId: string, seasonId: string | null, size: string): string => `sizeweight:${styleId}:${seasonId ?? 'all'}:${size}`

const WEIGHT = /^\d{1,5}(\.\d{1,4})?$/

/** A weights object's problems against the style's range (1 to 100 sizes of the range; each above 0, at most 4 decimals). */
export function weightsProblems(weights: Readonly<Record<string, string>>, sizes: readonly string[], at = 'body/weights'): Issue[] {
  const entries = Object.entries(weights)
  const issues: Issue[] = []
  if (entries.length === 0 || entries.length > WEIGHT_LIMITS.sizes) issues.push({ path: at, message: 'Weigh 1 to 100 sizes.' })
  for (const [size, weight] of entries) {
    if (!sizes.includes(size)) issues.push({ path: `${at}/${size}`, message: `${size} is not a size of the style's range.` })
    else if (!WEIGHT.test(weight) || !new Decimal(weight).gt(0)) issues.push({ path: `${at}/${size}`, message: 'A weight above 0 with at most 4 decimals.' })
  }
  return issues
}

/** Weights as kept: sizes in the range's order, 4 decimals. */
export function normalWeights(weights: Readonly<Record<string, string>>, sizes: readonly string[]): Record<string, string> {
  return Object.fromEntries(sizes.filter((size) => weights[size] !== undefined).map((size) => [size, new Decimal(weights[size]!).toFixed(4)]))
}

export interface WeightCandidates {
  /** The style's own weights for the season (size → weight). */
  readonly season: Readonly<Record<string, string>> | null
  /** The style's own weights for every season. */
  readonly everySeason: Readonly<Record<string, string>> | null
  /** The shares of the size curve the sheet names. */
  readonly curve: Readonly<Record<string, string>> | null
}

/** The weights a sheet uses: the season's, else every season's, else the size curve's, else none. */
export function pickWeights(candidates: WeightCandidates, sizes: readonly string[]): { readonly source: WeightSource; readonly weights: Record<string, string> | null } {
  const usable = (weights: Readonly<Record<string, string>> | null) => {
    if (weights === null) return null
    const kept = normalWeights(Object.fromEntries(Object.entries(weights).filter(([size, weight]) => sizes.includes(size) && WEIGHT.test(weight) && new Decimal(weight).gt(0))), sizes)
    return Object.keys(kept).length > 0 ? kept : null
  }
  const season = usable(candidates.season)
  if (season) return { source: 'SEASON', weights: season }
  const every = usable(candidates.everySeason)
  if (every) return { source: 'EVERY_SEASON', weights: every }
  const curve = usable(candidates.curve)
  if (curve) return { source: 'SIZE_CURVE', weights: curve }
  return { source: 'NONE', weights: null }
}

export interface SizeTotal {
  readonly size: string
  /** null: the size misses an input. */
  readonly total: string | null
}

export interface Weighted {
  /** null without weights or while a weighted size misses an input. */
  readonly weighted: string | null
  /** The weighted sizes whose cost is not complete. */
  readonly missing: readonly string[]
  /** Each weighted size's share of the mix, percent, 2 places. */
  readonly shares: readonly { readonly size: string; readonly weight: string; readonly sharePct: string }[]
}

/** The weighted cost of a size mix (see the module comment). */
export function weightedCost(totals: readonly SizeTotal[], weights: Readonly<Record<string, string>> | null): Weighted {
  if (weights === null) return { weighted: null, missing: [], shares: [] }
  const entries = Object.entries(weights)
  const sum = entries.reduce((total, [, weight]) => total.plus(weight), new Decimal(0))
  const shares = entries.map(([size, weight]) => ({ size, weight, sharePct: decimalText(new Decimal(weight).dividedBy(sum).times(100).toDecimalPlaces(2, Decimal.ROUND_HALF_UP)) }))
  const missing = entries.filter(([size]) => (totals.find((entry) => entry.size === size)?.total ?? null) === null).map(([size]) => size)
  if (missing.length > 0 || sum.isZero()) return { weighted: null, missing, shares }
  const weighted = entries.reduce((total, [size, weight]) => total.plus(new Decimal(totals.find((entry) => entry.size === size)!.total!).times(weight)), new Decimal(0)).dividedBy(sum)
  return { weighted: six(weighted), missing, shares }
}

export interface SurchargeSuggestion {
  readonly size: string
  /** The cost above the base size's (6 places). */
  readonly extraCost: string
  /** The extra cost, percent of the base size's cost, 2 places. */
  readonly extraPct: string
  /** The price surcharge that keeps the target margin; null without a target margin. */
  readonly priceSurcharge: string | null
}

/** Size surcharges suggested for the big sizes (see the module comment); none while the base size misses an input. */
export function sizeSurcharges(input: { readonly totals: readonly SizeTotal[]; readonly sizes: readonly string[]; readonly baseSize: string; readonly targetMarginPct: string | null; readonly currency: CurrencyCode; readonly fromPct?: string }): SurchargeSuggestion[] {
  const base = input.totals.find((entry) => entry.size === input.baseSize)?.total ?? null
  const at = input.sizes.indexOf(input.baseSize)
  if (base === null || at < 0 || !new Decimal(base).gt(0)) return []
  const from = new Decimal(input.fromPct ?? SURCHARGE_FROM_PCT)
  const margin = input.targetMarginPct === null ? null : new Decimal(input.targetMarginPct)
  return input.sizes.slice(at + 1).flatMap((size) => {
    const total = input.totals.find((entry) => entry.size === size)?.total ?? null
    if (total === null) return []
    const extra = new Decimal(total).minus(base)
    const pct = extra.dividedBy(base).times(100)
    if (pct.lt(from)) return []
    const priceSurcharge = margin === null || margin.gte(100) ? null : decimalText(extra.times(100).dividedBy(new Decimal(100).minus(margin)).toDecimalPlaces(minorPlaces(input.currency), Decimal.ROUND_UP))
    return [{ size, extraCost: six(extra), extraPct: decimalText(pct.toDecimalPlaces(2, Decimal.ROUND_HALF_UP)), priceSurcharge }]
  })
}
