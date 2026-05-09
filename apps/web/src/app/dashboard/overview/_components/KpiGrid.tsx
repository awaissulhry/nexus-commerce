'use client'

import { ArrowDownRight, ArrowUpRight } from 'lucide-react'
import { Card } from '@/components/ui/Card'
import { cn } from '@/lib/utils'
import {
  formatCurrency,
  formatDelta,
  NUM_FMT,
} from '../_lib/format'
import type { OverviewPayload, T } from '../_lib/types'

/**
 * The four-card headline strip: revenue, orders, AOV, units. Each
 * card carries a delta pill against the previous period of equal
 * length, plus a subtle "prev: …" line. When orders span more than
 * one currency the secondary line below the strip lists the
 * non-primary contributions.
 */
export default function KpiGrid({
  t,
  totals,
  currency,
}: {
  t: T
  totals: OverviewPayload['totals']
  currency: OverviewPayload['currency']
}) {
  const primary = currency.primary
  const secondaries = currency.breakdown.filter(
    (b) => b.code !== primary && b.current >= 1,
  )
  return (
    <div className="space-y-2">
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
        <KpiCard
          t={t}
          label={t('overview.kpi.revenue')}
          value={formatCurrency(totals.revenue.current, primary)}
          delta={formatDelta(totals.revenue.deltaPct, t)}
          prevValue={formatCurrency(totals.revenue.previous, primary)}
          series={totals.revenue.series}
          sparkColor="emerald"
        />
        <KpiCard
          t={t}
          label={t('overview.kpi.orders')}
          value={NUM_FMT.format(totals.orders.current)}
          delta={formatDelta(totals.orders.deltaPct, t)}
          prevValue={NUM_FMT.format(totals.orders.previous)}
          series={totals.orders.series}
          sparkColor="blue"
        />
        <KpiCard
          t={t}
          label={t('overview.kpi.aov')}
          value={formatCurrency(totals.aov.current, primary)}
          delta={formatDelta(totals.aov.deltaPct, t)}
          prevValue={formatCurrency(totals.aov.previous, primary)}
          series={totals.aov.series}
          sparkColor="violet"
        />
        <KpiCard
          t={t}
          label={t('overview.kpi.units')}
          value={NUM_FMT.format(totals.units.current)}
          delta={formatDelta(totals.units.deltaPct, t)}
          prevValue={NUM_FMT.format(totals.units.previous)}
          series={totals.units.series}
          sparkColor="amber"
        />
      </div>
      {secondaries.length > 0 && (
        <div className="text-xs text-slate-500 dark:text-slate-400 pl-1">
          {t('overview.kpi.includes')}{' '}
          {secondaries.map((s, i) => (
            <span key={s.code}>
              {i > 0 && ' · '}
              <span className="tabular-nums">
                {formatCurrency(s.current, s.code)}
              </span>{' '}
              {s.code}
            </span>
          ))}
        </div>
      )}
    </div>
  )
}

type SparkColor = 'emerald' | 'blue' | 'violet' | 'amber'

const SPARK_STROKE: Record<SparkColor, string> = {
  emerald: 'rgb(16 185 129)',
  blue: 'rgb(59 130 246)',
  violet: 'rgb(139 92 246)',
  amber: 'rgb(245 158 11)',
}

function KpiCard({
  t,
  label,
  value,
  delta,
  prevValue,
  series,
  sparkColor,
}: {
  t: T
  label: string
  value: string
  delta: { label: string; tone: 'pos' | 'neg' | 'flat' | 'na' }
  prevValue: string
  series?: number[]
  sparkColor: SparkColor
}) {
  // Use Card with custom className to tighten the default p-4 down
  // to the px-4 py-3 the KPI strip wants. The dark-mode bg/border
  // come from Card; we just override padding.
  return (
    <Card noPadding className="px-4 py-3">
      <div className="text-sm text-slate-500 dark:text-slate-400 uppercase tracking-wide font-medium">
        {label}
      </div>
      <div className="mt-1 flex items-baseline justify-between gap-2 flex-wrap">
        <div className="text-[22px] font-semibold text-slate-900 dark:text-slate-100 tabular-nums">
          {value}
        </div>
        <DeltaPill delta={delta} />
      </div>
      {series && series.length > 1 && (
        <MiniSpark series={series} color={sparkColor} />
      )}
      <div className="mt-1 text-xs text-slate-400 dark:text-slate-500">
        {t('overview.kpi.prev')}{' '}
        <span className="tabular-nums">{prevValue}</span>
      </div>
    </Card>
  )
}

/**
 * In-card mini sparkline. ~24px tall, fills full width. Decorative
 * — no axis, no tooltip — its job is to give the operator's eye a
 * shape for "is this trend up, down, or flat?" before they commit
 * to reading the headline number.
 */
function MiniSpark({
  series,
  color,
}: {
  series: number[]
  color: SparkColor
}) {
  const w = 100
  const h = 24
  const pad = 1
  const max = Math.max(1, ...series)
  const xStep = (w - pad * 2) / Math.max(1, series.length - 1)
  const yScale = (v: number) => h - pad - ((h - pad * 2) * v) / max
  const path = series
    .map(
      (v, i) =>
        `${i === 0 ? 'M' : 'L'} ${(pad + i * xStep).toFixed(2)},${yScale(v).toFixed(2)}`,
    )
    .join(' ')
  return (
    <svg
      viewBox={`0 0 ${w} ${h}`}
      preserveAspectRatio="none"
      className="w-full h-[24px] mt-1.5"
      role="img"
      aria-hidden="true"
    >
      <path
        d={path}
        fill="none"
        stroke={SPARK_STROKE[color]}
        strokeWidth="1.25"
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  )
}

function DeltaPill({
  delta,
}: {
  delta: { label: string; tone: 'pos' | 'neg' | 'flat' | 'na' }
}) {
  // Custom delta pill (not <Badge>) because Badge doesn't carry the
  // up/down arrow icon that makes the trend direction glanceable.
  // Tones map directly to Badge's success/danger/default but with
  // an inline icon prefix.
  const tone =
    delta.tone === 'pos'
      ? 'bg-emerald-50 text-emerald-700 border-emerald-200 dark:bg-emerald-950/40 dark:text-emerald-400 dark:border-emerald-900'
      : delta.tone === 'neg'
      ? 'bg-rose-50 text-rose-700 border-rose-200 dark:bg-rose-950/40 dark:text-rose-400 dark:border-rose-900'
      : 'bg-slate-50 text-slate-500 border-slate-200 dark:bg-slate-800 dark:text-slate-400 dark:border-slate-700'
  const Icon =
    delta.tone === 'pos'
      ? ArrowUpRight
      : delta.tone === 'neg'
      ? ArrowDownRight
      : null
  return (
    <span
      className={cn(
        'inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded border text-xs font-medium tabular-nums',
        tone,
      )}
    >
      {Icon && <Icon className="w-3 h-3" />}
      {delta.label}
    </span>
  )
}
