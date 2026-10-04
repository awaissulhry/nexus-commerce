/**
 * DPS.4 — the one mapping from a metric name to (how to read it off an hourly cell, what unit it
 * displays in). Extracted from ScheduleBuilder so the Hourly Bids page and the
 * schedule builder read the SAME definitions — "ACoS" must mean the same thing on both, and a
 * second copy would drift the first time someone fixes a formula in one place.
 *
 * `RawCell` is the shape returned by GET /advertising/dayparting/heatmap.
 */
import type { MetricUnit } from './DaypartingHeatmap'

export interface RawCell {
  dow: number; hour: number
  costCents: number; salesCents: number
  orders: number; clicks: number; impressions: number
  acos: number | null; roas: number | null
}

// Mirrors the Helium 10 "Hourly Campaign Performance" metric list (see CHART_METRICS).
export const METRIC_VAL: Record<string, { f: (c: RawCell) => number; unit: MetricUnit }> = {
  Spend: { f: (c) => c.costCents / 100, unit: 'eur' },
  Sales: { f: (c) => c.salesCents / 100, unit: 'eur' },
  ACoS: { f: (c) => c.acos ?? 0, unit: 'pct' },
  ROAS: { f: (c) => c.roas ?? 0, unit: 'int' },
  Orders: { f: (c) => c.orders, unit: 'int' },
  Clicks: { f: (c) => c.clicks, unit: 'int' },
  Impressions: { f: (c) => c.impressions, unit: 'int' },
  CPC: { f: (c) => (c.clicks > 0 ? c.costCents / 100 / c.clicks : 0), unit: 'eur' },
  CTR: { f: (c) => (c.impressions > 0 ? (c.clicks / c.impressions) * 100 : 0), unit: 'pct' },
  CVR: { f: (c) => (c.clicks > 0 ? (c.orders / c.clicks) * 100 : 0), unit: 'pct' },
  CPA: { f: (c) => (c.orders > 0 ? c.costCents / 100 / c.orders : 0), unit: 'eur' },
}

export const metricVal = (m: string) => METRIC_VAL[m] ?? METRIC_VAL.Spend

// ── 3.10 — what an hourly cell honestly says ──────────────────────────────────────────────────────
//
// `metricVal` reads a ratio with no denominator as 0, which on this grid is the palest colour: an
// hour that spent and sold nothing showed 0% ACoS, the best cell on the board. The readers below
// say "no value" instead, and mark the one no-value case that is worse than any number shown
// (money spent, nothing sold). `metricVal` is left as it was for the schedule builder.

export interface MetricInfo {
  /** a count or an amount (Spend, Sales, Orders, Clicks, Impressions): 0 is a real 0, the top cell is the busiest */
  volume: boolean
  /** higher is worse (ACoS, CPC, CPA), so the darkest cell is the costliest hour */
  lowerIsBetter: boolean
  /** read off Marketing Stream's sales/orders, which are Amazon's 1-day attribution */
  oneDay: boolean
}

export const METRIC_INFO: Record<string, MetricInfo> = {
  Spend: { volume: true, lowerIsBetter: false, oneDay: false },
  Sales: { volume: true, lowerIsBetter: false, oneDay: true },
  Orders: { volume: true, lowerIsBetter: false, oneDay: true },
  Clicks: { volume: true, lowerIsBetter: false, oneDay: false },
  Impressions: { volume: true, lowerIsBetter: false, oneDay: false },
  ACoS: { volume: false, lowerIsBetter: true, oneDay: true },
  ROAS: { volume: false, lowerIsBetter: false, oneDay: true },
  CPC: { volume: false, lowerIsBetter: true, oneDay: false },
  CTR: { volume: false, lowerIsBetter: false, oneDay: false },
  CVR: { volume: false, lowerIsBetter: false, oneDay: true },
  CPA: { volume: false, lowerIsBetter: true, oneDay: true },
}

export const metricInfo = (m: string): MetricInfo => METRIC_INFO[m] ?? METRIC_INFO.Spend

/**
 * One cell's reading. `value: null` = no value for this metric in this hour, with `empty` saying why
 * in words; `worst` = the no-value case that is worse than any value shown (spend with no sales for
 * ACoS, spend with no orders for CPA).
 */
export interface CellReading { value: number | null; empty?: string; worst?: boolean }

export function metricReading(m: string, c: RawCell): CellReading {
  const cost = c.costCents / 100
  switch (m) {
    case 'ACoS':
      if (c.salesCents > 0) return { value: c.acos ?? (c.costCents / c.salesCents) * 100 }
      return c.costCents > 0 ? { value: null, empty: 'spend, no sales', worst: true } : { value: null, empty: 'no spend, no sales' }
    case 'ROAS':
      return c.costCents > 0 ? { value: c.roas ?? c.salesCents / c.costCents } : { value: null, empty: 'no spend' }
    case 'CPC':
      return c.clicks > 0 ? { value: cost / c.clicks } : { value: null, empty: 'no clicks' }
    case 'CTR':
      return c.impressions > 0 ? { value: (c.clicks / c.impressions) * 100 } : { value: null, empty: 'no impressions' }
    case 'CVR':
      return c.clicks > 0 ? { value: (c.orders / c.clicks) * 100 } : { value: null, empty: 'no clicks' }
    case 'CPA':
      if (c.orders > 0) return { value: cost / c.orders }
      return c.costCents > 0 ? { value: null, empty: 'spend, no orders', worst: true } : { value: null, empty: 'no spend, no orders' }
    default:
      return { value: metricVal(m).f(c) }
  }
}

const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']

/**
 * The grid's one-line read, in words. A volume metric names its busiest hour; a ratio names its
 * HIGHEST hour, because the top ACoS, CPC or CPA hour is the costliest, not the busiest. Hours with
 * no value are left out, and the hours that spent without selling are counted rather than ranked.
 */
export function peakLine(m: string, cells: Array<{ dow: number; hour: number } & CellReading>): { label: string; when: string | null; note: string | null } | null {
  const valued = cells.filter((c): c is { dow: number; hour: number; value: number } => c.value != null)
  const worst = cells.filter((c) => c.worst).length
  const note = worst ? `${worst} hour${worst === 1 ? '' : 's'} with ${m === 'CPA' ? 'spend and no orders' : 'spend and no sales'}` : null
  const top = valued.length ? valued.reduce((a, b) => (b.value > a.value ? b : a), valued[0]) : null
  if (!top || top.value <= 0) return note ? { label: `Highest ${m}`, when: null, note } : null
  const when = `${DAY_NAMES[top.dow] ?? ''} ${String(top.hour).padStart(2, '0')}:00`
  return { label: metricInfo(m).volume ? 'Busiest' : `Highest ${m}`, when, note }
}

/** The card's note on how to read the colours for this metric, in words. */
export function metricLegendNote(m: string): string {
  const info = metricInfo(m)
  if (info.volume) return 'Darker cells are higher.'
  const parts = [info.lowerIsBetter ? `Darker cells are higher ${m}, which costs more.` : `Darker cells are higher ${m}.`]
  parts.push('A cell marked — has no value in that hour (nothing to divide by).')
  if (m === 'ACoS') parts.push('A cell marked ∞ spent money and sold nothing, which is worse than any ACoS shown.')
  if (m === 'CPA') parts.push('A cell marked ∞ spent money and got no orders, which is worse than any CPA shown.')
  return parts.join(' ')
}

/**
 * Marketing Stream sends Amazon's 1-DAY attributed sales and orders (stored in the hourly table's 7-day
 * columns), so every number built on them differs from the 7-day reports elsewhere in Nexus. Said per
 * metric, in the direction it moves. null for metrics that do not use sales or orders.
 */
export function oneDayNote(m: string): string | null {
  if (!metricInfo(m).oneDay) return null
  const src = "Amazon's 1-day attributed sales and orders from Marketing Stream"
  if (m === 'Sales' || m === 'Orders') return `${m} here are ${src}, so they read lower than the 7-day reports elsewhere in Nexus.`
  const dir = metricInfo(m).lowerIsBetter ? 'higher' : 'lower'
  return `${m} here is built on ${src}, so it reads ${dir} than the 7-day figure elsewhere in Nexus.`
}
