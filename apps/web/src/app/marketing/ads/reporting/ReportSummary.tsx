'use client'

/**
 * RPT.10 · R4 — KPI tiles, period comparison, and the chart they drive.
 *
 * The tiles ARE the chart's control, which is the Amazon Advertising console's model and the
 * one operators already know: tick Impressions, Clicks, Sales and ACOS and all four are
 * plotted together. Clicking a tile toggles its metric on and off the chart; the chart's own
 * picker does the same thing to the same state, so the two can never disagree.
 *
 * This replaced a single-metric chart. The old note here argued for one line on the grounds
 * that a second axis makes unrelated scales look like they cross — a real hazard, and the
 * reason `MetricChart` gives every plotted metric its OWN domain and says so under the legend,
 * rather than the reason to refuse the question. "Show me spend against sales" is the question,
 * and a chart that cannot answer it sends you to Amazon's console to ask it there.
 *
 * Delta direction still uses status colour PLUS an arrow PLUS a signed number, never colour
 * alone — and metrics with no preferred direction (spend) stay uncoloured rather than being
 * editorialised into good or bad.
 */
import { useMemo } from 'react'
import { ArrowDownRight, ArrowUpRight, Minus } from 'lucide-react'
import { Area, AreaChart, ResponsiveContainer } from 'recharts'
import { SegmentedControl } from '@/design-system/primitives'
import { MetricChart, type ChartMetric, type MetricUnit } from '../_shared/MetricChart'
import { formatCell, type ColumnFormat } from './report-api'
import { deltaIsGood, type CompareMode, type KpiMetric, type SummaryResult } from './summary-api'

const BUCKET_LABEL: Record<string, string> = { day: 'day', week: 'week', month: 'month' }

/** The report vocabulary (a column format) in the chart's (a unit). */
function unitOf(format: ColumnFormat): MetricUnit {
  if (format === 'money') return 'eur'
  if (format === 'pct') return 'pct'
  if (format === 'ratio') return 'ratio'
  return 'count'
}

function fmtDelta(d: number | null): string {
  if (d == null) return '—'
  const pct = d * 100
  const abs = Math.abs(pct)
  // Below 0.1% the sign is noise; say "flat" rather than "+0.0%".
  if (abs < 0.1) return 'flat'
  return `${pct > 0 ? '+' : '−'}${abs.toLocaleString('en-GB', { maximumFractionDigits: 1 })}%`
}

function Sparkline({ data, metricId, color }: {
  data: Array<Record<string, number | string | null>>; metricId: string; color: string
}) {
  if (data.length < 2) return <div className="rpt-spark-empty" aria-hidden />
  return (
    <div className="rpt-spark" aria-hidden>
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={data} margin={{ top: 2, right: 0, bottom: 0, left: 0 }}>
          <Area
            type="monotone" dataKey={metricId} stroke={color} strokeWidth={2}
            fill={color} fillOpacity={0.12} dot={false} isAnimationActive={false} connectNulls
          />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  )
}

function KpiTile({
  m, currency, series, plotted, color, onToggle,
}: {
  m: KpiMetric
  currency: string
  series: SummaryResult['series']
  plotted: boolean
  color: string
  onToggle: () => void
}) {
  const good = deltaIsGood(m)
  const Icon = m.deltaPct == null || Math.abs(m.deltaPct) < 0.001 ? Minus : m.deltaPct > 0 ? ArrowUpRight : ArrowDownRight
  const tone = good === null ? 'neutral' : good ? 'good' : 'bad'
  // Stays a raw <button> rather than the DS `Card onClick`: `CardProps` is
  // `Omit<HTMLAttributes, 'title'>`, and this tooltip is the only thing telling a sighted
  // operator the tile is clickable at all. Logged in DS-GAPS.md.
  return (
    <button
      type="button"
      className={`rpt-kpi${plotted ? ' on' : ''}`}
      onClick={onToggle}
      aria-pressed={plotted}
      title={plotted ? `Remove ${m.label} from the chart` : `Add ${m.label} to the chart`}
    >
      <span className="lbl">
        {/* The tile carries the line's own colour, so tile and chart identify each other
            without the eye having to match a label to a legend. */}
        <span className="sw" style={{ background: plotted ? color : 'transparent' }} aria-hidden />
        {m.label}
      </span>
      <span className="val">{formatCell(m.current, m.format, currency)}</span>
      <span className={`dlt t-${tone}`}>
        <Icon size={12} aria-hidden />
        {fmtDelta(m.deltaPct)}
        {m.previous != null && (
          <span className="prev">from {formatCell(m.previous, m.format, currency)}</span>
        )}
      </span>
      <Sparkline data={series} metricId={m.id} color={plotted ? color : '#9aa5b4'} />
    </button>
  )
}

/** Kept in step with MetricChart's palette so a tile and its line are never different colours. */
const SERIES_COLORS = ['#1f6fde', '#c2410c', '#15803d', '#7c3aed', '#0e7490', '#c0392b']

export function ReportSummary({
  summary, loading, selected, onSelectedChange, compare, onCompare,
}: {
  summary: SummaryResult | null
  loading: boolean
  selected: string[]
  onSelectedChange: (keys: string[]) => void
  compare: CompareMode
  onCompare: (c: CompareMode) => void
}) {
  const metrics: ChartMetric[] = useMemo(
    () => (summary?.metrics ?? []).map((m) => ({ key: m.id, label: m.label, unit: unitOf(m.format) })),
    [summary],
  )

  // Whatever the page asks for, only metrics this report actually has can be plotted — a report
  // switch must not leave a stale key selected and the chart empty.
  const live = useMemo(
    () => selected.filter((k) => metrics.some((m) => m.key === k)),
    [selected, metrics],
  )
  const effective = live.length > 0 ? live : metrics.slice(0, 1).map((m) => m.key)
  const colorOf = (key: string) => SERIES_COLORS[effective.indexOf(key) % SERIES_COLORS.length]

  if (!summary && !loading) return null

  const toggle = (id: string) => {
    if (effective.includes(id)) {
      if (effective.length === 1) return
      onSelectedChange(effective.filter((k) => k !== id))
    } else if (effective.length < SERIES_COLORS.length) {
      onSelectedChange([...effective, id])
    }
  }

  return (
    <div className={`rpt-summary${loading ? ' is-loading' : ''}`}>
      <div className="rpt-summary-hd">
        <span className="ttl">
          {summary?.comparisonWindow
            ? `Compared with ${summary.comparisonWindow.from} → ${summary.comparisonWindow.to}`
            : 'No comparison'}
        </span>
        <SegmentedControl
          className="rpt-seg"
          size="sm"
          ariaLabel="Comparison period"
          value={compare}
          onChange={(v) => onCompare(v as CompareMode)}
          options={[{ value: 'previous', label: 'Previous period' }, { value: 'yoy', label: 'Last year' }, { value: 'none', label: 'None' }]}
        />
      </div>

      <div className="rpt-kpis">
        {(summary?.metrics ?? []).map((m) => (
          <KpiTile
            key={m.id}
            m={m}
            currency={summary!.currency}
            series={summary!.series}
            plotted={effective.includes(m.id)}
            color={colorOf(m.id)}
            onToggle={() => toggle(m.id)}
          />
        ))}
      </div>

      {summary && !summary.timeSeries && summary.noSeriesReason && (
        <p className="rpt-noseries">{summary.noSeriesReason}</p>
      )}

      {summary && summary.timeSeries && summary.series.length > 1 && (
        <MetricChart
          title="Performance over time"
          subtitle={`By ${BUCKET_LABEL[summary.bucket]} · ${summary.window.from} → ${summary.window.to}`}
          // The chart keys on `date`; the summary calls the same field `bucket`.
          data={summary.series.map((r) => ({ ...r, date: r.bucket as string }))}
          metrics={metrics}
          selected={effective}
          onSelectedChange={onSelectedChange}
          storageKey="rpt-chart"
          emptyLabel="No rows in this window."
        />
      )}
    </div>
  )
}
