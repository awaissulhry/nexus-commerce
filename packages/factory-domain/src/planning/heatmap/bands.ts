/**
 * The load heatmap (B-W2b-321; PLN-117; design planning.capacity › Load heatmap "Lanes down, weeks across, cells coloured
 * by % load with the number in each cell"), pure. A cell's band names its colour; the number is always written in the cell
 * ("112%"), so colour is never the only signal. A cell with nothing available (a closed week, a workshop with no capacity
 * set) is UNKNOWN and writes "—", never 0 %.
 *
 *   LOW      below 70 %
 *   MEDIUM   70 % to below 90 %
 *   HIGH     90 % to 100 %
 *   OVER     above 100 %
 *   UNKNOWN  nothing available
 */

export const HEAT_BANDS = ['LOW', 'MEDIUM', 'HIGH', 'OVER', 'UNKNOWN'] as const
export type HeatBand = (typeof HEAT_BANDS)[number]

export const BAND_LIMITS = Object.freeze({ medium: 70, high: 90, over: 100 })

/** The band of a load percent ("112.0"); null: nothing available. */
export function heatBand(loadPct: string | null): HeatBand {
  if (loadPct === null) return 'UNKNOWN'
  const pct = Number(loadPct)
  if (!Number.isFinite(pct)) return 'UNKNOWN'
  if (pct > BAND_LIMITS.over) return 'OVER'
  if (pct >= BAND_LIMITS.high) return 'HIGH'
  if (pct >= BAND_LIMITS.medium) return 'MEDIUM'
  return 'LOW'
}

/** What the cell writes: the whole percent ("112%"), "—" when nothing is available. */
export function cellText(loadPct: string | null): string {
  if (loadPct === null) return '—'
  const pct = Number(loadPct)
  return Number.isFinite(pct) ? `${Math.round(pct)}%` : '—'
}

/** The legend, in words. */
export const LEGEND: readonly { readonly band: HeatBand; readonly words: string }[] = Object.freeze([
  { band: 'LOW', words: `Below ${BAND_LIMITS.medium}%` },
  { band: 'MEDIUM', words: `${BAND_LIMITS.medium}% to ${BAND_LIMITS.high - 1}%` },
  { band: 'HIGH', words: `${BAND_LIMITS.high}% to ${BAND_LIMITS.over}%` },
  { band: 'OVER', words: `Over ${BAND_LIMITS.over}%` },
  { band: 'UNKNOWN', words: 'Nothing available (closed, or no capacity set): —' },
])

/** The weeks a heatmap covers: at least one, at most this many. */
export const MAX_WEEKS = 26
export const DEFAULT_WEEKS = 8
