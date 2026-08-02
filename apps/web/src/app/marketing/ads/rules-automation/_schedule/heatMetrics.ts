/**
 * DPS.4 — the one mapping from a metric name to (how to read it off an hourly cell, what unit it
 * displays in). Extracted from ScheduleBuilder so the Rank & Dayparting Schedules page and the
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
