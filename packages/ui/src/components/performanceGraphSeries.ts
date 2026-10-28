/**
 * PerformanceGraph — which marks a chart draws for its two series, as plain data (no React, no Recharts), so Node tests
 * cover them (performanceGraphSeries.vitest.test.ts).
 *
 * A series is a line (the default) or bars (`shape: 'bar'`). A series with `stack` draws one bar per part, stacked on
 * its axis (eBay "feedback by type": positive, neutral, negative); its own `key` is then not drawn. Bars come first so a
 * line is painted over them. The legend and the tooltip read the same list, so a part is named and coloured the same
 * everywhere.
 */

export interface ChartStackPart {
  key: string
  label: string
  color: string
}

/** The fields of a `ChartSeries` the marks need. */
export interface ChartSeriesShape {
  key: string
  label: string
  color: string
  axis: 'left' | 'right'
  format?: (v: number) => string
  shape?: 'line' | 'bar'
  stack?: readonly ChartStackPart[]
}

export interface ChartMark {
  kind: 'line' | 'bar'
  key: string
  label: string
  color: string
  axis: 'left' | 'right'
  /** Bars of one stacked series share it. */
  stackId?: string
  format?: (v: number) => string
}

/** The marks of one series: a line, one bar, or one bar per stacked part. */
export function seriesMarks(series: ChartSeriesShape): ChartMark[] {
  const base = { axis: series.axis, format: series.format }
  if (series.stack && series.stack.length > 0) {
    return series.stack.map(part => ({ ...base, kind: 'bar' as const, key: part.key, label: part.label, color: part.color, stackId: `stack:${series.key}` }))
  }
  return [{ ...base, kind: series.shape === 'bar' ? 'bar' : 'line', key: series.key, label: series.label, color: series.color }]
}

/** Both series' marks, bars first (a line is drawn over them), each in the order given. */
export function chartMarks(left: ChartSeriesShape, right: ChartSeriesShape): ChartMark[] {
  const all = [...seriesMarks(left), ...seriesMarks(right)]
  return [...all.filter(m => m.kind === 'bar'), ...all.filter(m => m.kind === 'line')]
}

/** The legend: every mark in the order the series were given (left first), a bar's swatch a square, a line's a line. */
export function legendMarks(left: ChartSeriesShape, right: ChartSeriesShape): ChartMark[] {
  return [...seriesMarks(left), ...seriesMarks(right)]
}

/** The mark a tooltip row belongs to (Recharts names it by its data key). */
export function markOf(marks: readonly ChartMark[], dataKey: unknown): ChartMark | null {
  return marks.find(m => m.key === dataKey) ?? null
}

/** A stacked bar's total at one point (the tooltip's "In all" line); null when no part has a number. */
export function stackTotal(row: Record<string, unknown>, parts: readonly ChartStackPart[]): number | null {
  let total = 0
  let any = false
  for (const part of parts) {
    const v = row[part.key]
    if (typeof v === 'number' && Number.isFinite(v)) {
      total += v
      any = true
    }
  }
  return any ? total : null
}
