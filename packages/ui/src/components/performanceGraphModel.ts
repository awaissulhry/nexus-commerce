/**
 * PerformanceGraph — the parts that are pure (no React, no Recharts), so Node tests cover them.
 *
 * A line needs two points: a value whose neighbours are both empty (null, missing, not a number) drew nothing at all —
 * on Reviews › Overview a month with an average rating between two months without one vanished from the chart. Those
 * values get a dot (`isolatedPoints`). A series can also fix its axis (`axisScale`): a 5-star rating fitted to its data
 * ran 0–8.
 */

/** The indexes of values that have no value on either side, so no line segment reaches them. */
export function isolatedPoints(values: ReadonlyArray<unknown>): Set<number> {
  const has = (i: number) => {
    const v = values[i]
    return typeof v === 'number' && Number.isFinite(v)
  }
  const out = new Set<number>()
  for (let i = 0; i < values.length; i++) if (has(i) && !has(i - 1) && !has(i + 1)) out.add(i)
  return out
}

export interface AxisScale {
  domain?: [number, number]
  ticks?: number[]
}

/**
 * A series' fixed axis: its `domain` (a broken one is ignored) and its `ticks` inside it. Nothing given → `{}`, and
 * Recharts fits the axis to the data as before. Data outside a fixed domain still widens it (Recharts'
 * `allowDataOverflow` stays off), so no value is ever drawn off the chart.
 */
export function axisScale(series: { domain?: readonly [number, number]; ticks?: readonly number[] } | null | undefined): AxisScale {
  if (!series) return {}
  const out: AxisScale = {}
  const d = series.domain
  const domain: [number, number] | null = d != null && Number.isFinite(d[0]) && Number.isFinite(d[1]) && d[0] < d[1] ? [d[0], d[1]] : null
  if (domain) out.domain = domain
  const ticks = series.ticks?.filter((t) => Number.isFinite(t) && (!domain || (t >= domain[0] && t <= domain[1])))
  if (ticks && ticks.length > 0) out.ticks = [...ticks].sort((a, b) => a - b)
  return out
}
