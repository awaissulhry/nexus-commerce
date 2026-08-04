'use client'

/**
 * RPT.10 — KPI tiles, period comparison and the trend chart.
 *
 * Built to the dataviz rules, and two of them shaped the design:
 *
 * 1. **No dual-axis chart, ever.** Both chart components already in this repo
 *    (design-system PerformanceGraph, insights TrendChart) put a second measure
 *    on a right-hand axis, which makes two unrelated scales look like they cross.
 *    So this uses SMALL MULTIPLES instead: every tile owns a single-series
 *    sparkline, and the focused chart below plots exactly one metric. One scale,
 *    one line, nothing to misread.
 *
 * 2. **A single series needs no categorical palette.** Every chart here has one
 *    line, so identity is never encoded by hue — the title names it. One
 *    validated accent is used throughout (#2a78d6 light / #3987e5 dark, both
 *    passing all six checks against this console's real surfaces).
 *
 * Delta direction uses status colour PLUS an arrow PLUS a signed number, never
 * colour alone — and metrics with no preferred direction (spend) are shown
 * uncoloured rather than editorialised into good or bad.
 */
import { useMemo } from 'react'
import { ArrowDownRight, ArrowUpRight, Minus } from 'lucide-react'
import {
  Area, AreaChart, CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis,
} from 'recharts'
import { formatCell } from './report-api'
import { deltaIsGood, type CompareMode, type KpiMetric, type SummaryResult } from './summary-api'

const BUCKET_LABEL: Record<string, string> = { day: 'day', week: 'week', month: 'month' }

function fmtDelta(d: number | null): string {
  if (d == null) return '—'
  const pct = d * 100
  const abs = Math.abs(pct)
  // Below 0.1% the sign is noise; say "flat" rather than "+0.0%".
  if (abs < 0.1) return 'flat'
  return `${pct > 0 ? '+' : '−'}${abs.toLocaleString('en-GB', { maximumFractionDigits: 1 })}%`
}

function shortDay(iso: string, bucket: string): string {
  const d = new Date(`${iso}T00:00:00Z`)
  if (bucket === 'month') return d.toLocaleDateString('en-GB', { month: 'short', year: '2-digit', timeZone: 'UTC' })
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' })
}

function Sparkline({ data, metricId }: { data: Array<Record<string, number | string | null>>; metricId: string }) {
  if (data.length < 2) return <div className="rpt-spark-empty" aria-hidden />
  return (
    <div className="rpt-spark" aria-hidden>
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={data} margin={{ top: 2, right: 0, bottom: 0, left: 0 }}>
          <Area
            type="monotone"
            dataKey={metricId}
            stroke="var(--rpt-series-1)"
            strokeWidth={2}
            fill="var(--rpt-series-1)"
            fillOpacity={0.12}
            dot={false}
            isAnimationActive={false}
            connectNulls
          />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  )
}

function KpiTile({
  m, currency, series, focused, onFocus,
}: {
  m: KpiMetric
  currency: string
  series: SummaryResult['series']
  focused: boolean
  onFocus: () => void
}) {
  const good = deltaIsGood(m)
  const Icon = m.deltaPct == null || Math.abs(m.deltaPct) < 0.001 ? Minus : m.deltaPct > 0 ? ArrowUpRight : ArrowDownRight
  const tone = good === null ? 'neutral' : good ? 'good' : 'bad'
  return (
    <button
      type="button"
      className={`rpt-kpi${focused ? ' on' : ''}`}
      onClick={onFocus}
      aria-pressed={focused}
      title={`Show ${m.label} over time`}
    >
      <span className="lbl">{m.label}</span>
      <span className="val">{formatCell(m.current, m.format, currency)}</span>
      <span className={`dlt t-${tone}`}>
        <Icon size={12} aria-hidden />
        {fmtDelta(m.deltaPct)}
        {m.previous != null && (
          <span className="prev">from {formatCell(m.previous, m.format, currency)}</span>
        )}
      </span>
      <Sparkline data={series} metricId={m.id} />
    </button>
  )
}

export function ReportSummary({
  summary, loading, focus, onFocus, compare, onCompare,
}: {
  summary: SummaryResult | null
  loading: boolean
  focus: string | null
  onFocus: (id: string) => void
  compare: CompareMode
  onCompare: (c: CompareMode) => void
}) {
  const focused = useMemo(
    () => summary?.metrics.find((m) => m.id === focus) ?? summary?.metrics[0] ?? null,
    [summary, focus],
  )

  if (!summary && !loading) return null

  return (
    <div className={`rpt-summary${loading ? ' is-loading' : ''}`}>
      <div className="rpt-summary-hd">
        <span className="ttl">
          {summary?.comparisonWindow
            ? `Compared with ${summary.comparisonWindow.from} → ${summary.comparisonWindow.to}`
            : 'No comparison'}
        </span>
        <span className="rpt-seg" role="group" aria-label="Comparison period">
          {([['previous', 'Previous period'], ['yoy', 'Last year'], ['none', 'None']] as const).map(([v, l]) => (
            <button
              key={v}
              type="button"
              className={compare === v ? 'on' : ''}
              aria-pressed={compare === v}
              onClick={() => onCompare(v)}
            >
              {l}
            </button>
          ))}
        </span>
      </div>

      <div className="rpt-kpis">
        {(summary?.metrics ?? []).map((m) => (
          <KpiTile
            key={m.id}
            m={m}
            currency={summary!.currency}
            series={summary!.series}
            focused={focused?.id === m.id}
            onFocus={() => onFocus(m.id)}
          />
        ))}
      </div>

      {summary && !summary.timeSeries && summary.noSeriesReason && (
        <p className="rpt-noseries">{summary.noSeriesReason}</p>
      )}

      {summary && summary.timeSeries && summary.series.length > 1 && focused && (
        <figure className="rpt-chart">
          <figcaption>
            {focused.label} by {BUCKET_LABEL[summary.bucket]}
          </figcaption>
          <div className="plot">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={summary.series} margin={{ top: 8, right: 12, bottom: 4, left: 4 }}>
                {/* Recessive grid: horizontal only, so it guides the eye without
                    competing with the single line it exists to support. */}
                <CartesianGrid stroke="var(--rpt-grid)" strokeDasharray="2 4" vertical={false} />
                <XAxis
                  dataKey="bucket"
                  tickFormatter={(v: string) => shortDay(String(v ?? ''), summary.bucket)}
                  tick={{ fill: 'var(--text-tertiary)', fontSize: 11 }}
                  tickLine={false}
                  axisLine={{ stroke: 'var(--rpt-grid)' }}
                  minTickGap={28}
                />
                <YAxis
                  tick={{ fill: 'var(--text-tertiary)', fontSize: 11 }}
                  tickLine={false}
                  axisLine={false}
                  width={62}
                  tickFormatter={(v: number) => formatCell(v, focused.format, summary.currency)}
                />
                <Tooltip
                  cursor={{ stroke: 'var(--rpt-grid)', strokeWidth: 1 }}
                  contentStyle={{
                    background: 'var(--surface-card)',
                    border: '1px solid var(--border-subtle)',
                    borderRadius: 6,
                    fontSize: 12,
                    color: 'var(--text-primary)',
                  }}
                  labelFormatter={(v) => shortDay(String(v ?? ''), summary.bucket)}
                  formatter={(v) => [formatCell(v, focused.format, summary.currency), focused.label] as [string, string]}
                />
                <Line
                  type="monotone"
                  dataKey={focused.id}
                  stroke="var(--rpt-series-1)"
                  strokeWidth={2}
                  dot={false}
                  activeDot={{ r: 4, strokeWidth: 2, stroke: 'var(--surface-card)' }}
                  isAnimationActive={false}
                  connectNulls
                />
              </LineChart>
            </ResponsiveContainer>
          </div>
        </figure>
      )}
    </div>
  )
}
