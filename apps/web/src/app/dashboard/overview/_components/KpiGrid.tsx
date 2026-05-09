'use client'

import Link from 'next/link'
import { ArrowDownRight, ArrowUpRight } from 'lucide-react'
import { Card } from '@/components/ui/Card'
import { cn } from '@/lib/utils'
import {
  formatCurrency,
  formatDelta,
  NUM_FMT,
  PCT_FMT,
} from '../_lib/format'
import type { OverviewPayload, T } from '../_lib/types'

function formatPct(value: number): string {
  // returnsRate ships as 0–100 from the backend; PCT_FMT expects
  // 0–1 because it uses style:percent. Divide once at the boundary.
  return PCT_FMT.format(value / 100)
}

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
          href="/dashboard/analytics/revenue"
        />
        <KpiCard
          t={t}
          label={t('overview.kpi.orders')}
          value={NUM_FMT.format(totals.orders.current)}
          delta={formatDelta(totals.orders.deltaPct, t)}
          prevValue={NUM_FMT.format(totals.orders.previous)}
          series={totals.orders.series}
          sparkColor="blue"
          href="/orders"
        />
        <KpiCard
          t={t}
          label={t('overview.kpi.aov')}
          value={formatCurrency(totals.aov.current, primary)}
          delta={formatDelta(totals.aov.deltaPct, t)}
          prevValue={formatCurrency(totals.aov.previous, primary)}
          series={totals.aov.series}
          sparkColor="violet"
          href="/dashboard/analytics/revenue"
        />
        <KpiCard
          t={t}
          label={t('overview.kpi.units')}
          value={NUM_FMT.format(totals.units.current)}
          delta={formatDelta(totals.units.deltaPct, t)}
          prevValue={NUM_FMT.format(totals.units.previous)}
          series={totals.units.series}
          sparkColor="amber"
          href="/dashboard/analytics/inventory"
        />
      </div>
      {/* DO.12 — second row: operational KPIs.
          Pending / late shipments are point-in-time counts (delta
          renders n/a). Returns rate is a percentage; refund value
          flows in primary currency. Late shipment value flushes
          rose when non-zero — that's an account-health risk on
          Amazon if it persists. */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
        <KpiCard
          t={t}
          label={t('overview.kpi.pendingShipments')}
          value={NUM_FMT.format(totals.pendingShipments.current)}
          delta={formatDelta(totals.pendingShipments.deltaPct, t)}
          prevValue=""
          sparkColor="blue"
          href="/fulfillment/outbound"
        />
        <KpiCard
          t={t}
          label={t('overview.kpi.lateShipments')}
          value={NUM_FMT.format(totals.lateShipments.current)}
          delta={formatDelta(totals.lateShipments.deltaPct, t)}
          prevValue=""
          sparkColor="amber"
          tone={totals.lateShipments.current > 0 ? 'rose' : 'slate'}
          href="/fulfillment/outbound"
        />
        <KpiCard
          t={t}
          label={t('overview.kpi.returnsRate')}
          value={formatPct(totals.returnsRate.current)}
          delta={formatDelta(totals.returnsRate.deltaPct, t)}
          prevValue={formatPct(totals.returnsRate.previous)}
          sparkColor="violet"
          href="/fulfillment/returns"
        />
        <KpiCard
          t={t}
          label={t('overview.kpi.refundValue')}
          value={formatCurrency(totals.refundValue.current, primary)}
          delta={formatDelta(totals.refundValue.deltaPct, t)}
          prevValue={formatCurrency(totals.refundValue.previous, primary)}
          sparkColor="amber"
          href="/fulfillment/returns"
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
  tone = 'slate',
  href,
}: {
  t: T
  label: string
  value: string
  delta: { label: string; tone: 'pos' | 'neg' | 'flat' | 'na' }
  /** Empty string hides the "prev:" footer entirely (operational KPIs
   * with no period analog use this). */
  prevValue: string
  series?: number[]
  sparkColor: SparkColor
  /** Override the headline value color — used by lateShipments to
   * flush rose when non-zero. */
  tone?: 'slate' | 'rose'
  /** When set, the card becomes a drill-down link. */
  href?: string
}) {
  const valueClass =
    tone === 'rose'
      ? 'text-rose-700 dark:text-rose-400'
      : 'text-slate-900 dark:text-slate-100'
  // DO.13 — clickable card. The whole tile is the hit target so the
  // operator can fingerprint a metric and tap-through, not aim at a
  // 12px chevron. Hover lifts the border tone for affordance; the
  // visited / focus rings come from focus-visible.
  const body = (
    <>
      <div className="text-sm text-slate-500 dark:text-slate-400 uppercase tracking-wide font-medium">
        {label}
      </div>
      <div className="mt-1 flex items-baseline justify-between gap-2 flex-wrap">
        <div
          className={cn(
            'text-[22px] font-semibold tabular-nums',
            valueClass,
          )}
        >
          {value}
        </div>
        <DeltaPill delta={delta} />
      </div>
      {series && series.length > 1 && (
        <MiniSpark series={series} color={sparkColor} />
      )}
      {prevValue && (
        <div className="mt-1 text-xs text-slate-400 dark:text-slate-500">
          {t('overview.kpi.prev')}{' '}
          <span className="tabular-nums">{prevValue}</span>
        </div>
      )}
    </>
  )
  if (href) {
    // DO.38 — aria-label combines label + value + delta so screen
    // readers announce a complete picture rather than three
    // separate fragments per card.
    const ariaLabel = [label, value, delta.label].filter(Boolean).join(', ')
    return (
      <Link
        href={href}
        aria-label={ariaLabel}
        className={cn(
          'block rounded-lg border bg-white dark:bg-slate-900 px-4 py-3 transition-colors',
          'border-slate-200 dark:border-slate-800',
          'hover:border-slate-300 dark:hover:border-slate-700',
          'hover:bg-slate-50/40 dark:hover:bg-slate-800/40',
          'focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/40',
        )}
      >
        {body}
      </Link>
    )
  }
  return (
    <Card noPadding className="px-4 py-3">
      {body}
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
