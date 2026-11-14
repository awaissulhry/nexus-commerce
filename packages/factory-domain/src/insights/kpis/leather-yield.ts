import { areaM2 } from '../../costing/valuation/rules'
import type { Uom } from '../../product/units/units'
import type { YieldEntry } from '../../production/yield/rules'
import { Dec, ZERO, type Decimal } from '../../tax/decimal'

/**
 * Leather yield and cutting waste (B-W2b-429; ANA-020 "net cut area ÷ hide area consumed, by grade, supplier lot and style"),
 * pure, on B-W2a-13's yield of each cut (production/yield/rules: a live cut log entry's area used, and the net area of the
 * pieces it cut when they make whole sets of the work order's parts).
 *
 *   cut       the hide area consumed by cuts whose pattern is known, in square metres (a cut of single parts has no known
 *             pattern: left out of both sides, never counted as all pattern)
 *   pattern   the pieces' net area (the BOM's need without its wastage), never more than the area it was cut from
 *   yield %   Σ pattern ÷ Σ cut × 100: areas are added first, the percent taken of the sums (never an average of percents);
 *             waste % = 100 − yield %
 *
 * Every hide's area is turned into square metres from its article's unit (ft², dm², m²), so hides of every article add up
 * (the layer: leather.area_cut, leather.area_pattern per site and day; KPI production.leather_yield). Never by cutter
 * (SCM-255; Statuto dei Lavoratori art. 4): by grade, supplier lot, style, site.
 */

export interface CutAreas {
  readonly cut: Decimal
  readonly pattern: Decimal
}

/** One cut's areas in square metres (zero both when its pattern is not known, or the unit is not an area). */
export function cutAreas(entry: YieldEntry, uom: Uom): CutAreas {
  if (entry.pattern === null) return { cut: ZERO, pattern: ZERO }
  const used = new Dec(entry.used)
  const cut = areaM2(used, uom)
  const pattern = areaM2(Dec.min(used, new Dec(entry.pattern)), uom)
  if (cut === null || pattern === null) return { cut: ZERO, pattern: ZERO }
  return { cut, pattern }
}

export const addAreas = (rows: readonly CutAreas[]): CutAreas => rows.reduce((sum, row) => ({ cut: sum.cut.plus(row.cut), pattern: sum.pattern.plus(row.pattern) }), { cut: ZERO, pattern: ZERO })

/** A share in percent of two sums, rounded half up (null when the whole is 0): the calculation's own rounding. */
export function percentOf(part: Decimal, whole: Decimal, decimals = 1): string | null {
  if (whole.isZero()) return null
  return part.div(whole).times(100).toDecimalPlaces(decimals, Dec.ROUND_HALF_UP).toFixed(decimals)
}

/** An area as the facts keep it (four places, square metres). */
export const areaText = (value: Decimal): string => value.toDecimalPlaces(4, Dec.ROUND_HALF_UP).toFixed(4)

/** The figures of summed areas: cut, pattern, waste (m²) and the yield and waste percent. */
export function yieldOfAreas(areas: CutAreas): { readonly cutM2: string; readonly patternM2: string; readonly wasteM2: string; readonly yieldPct: string | null; readonly wastePct: string | null } {
  const waste = Dec.max(ZERO, areas.cut.minus(areas.pattern))
  return { cutM2: areaText(areas.cut), patternM2: areaText(areas.pattern), wasteM2: areaText(waste), yieldPct: percentOf(areas.pattern, areas.cut), wastePct: percentOf(waste, areas.cut) }
}
