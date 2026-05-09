'use client'

import { ArrowDownRight, ArrowUpRight } from 'lucide-react'
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
        />
        <KpiCard
          t={t}
          label={t('overview.kpi.orders')}
          value={NUM_FMT.format(totals.orders.current)}
          delta={formatDelta(totals.orders.deltaPct, t)}
          prevValue={NUM_FMT.format(totals.orders.previous)}
        />
        <KpiCard
          t={t}
          label={t('overview.kpi.aov')}
          value={formatCurrency(totals.aov.current, primary)}
          delta={formatDelta(totals.aov.deltaPct, t)}
          prevValue={formatCurrency(totals.aov.previous, primary)}
        />
        <KpiCard
          t={t}
          label={t('overview.kpi.units')}
          value={NUM_FMT.format(totals.units.current)}
          delta={formatDelta(totals.units.deltaPct, t)}
          prevValue={NUM_FMT.format(totals.units.previous)}
        />
      </div>
      {secondaries.length > 0 && (
        <div className="text-xs text-slate-500 pl-1">
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

function KpiCard({
  t,
  label,
  value,
  delta,
  prevValue,
}: {
  t: T
  label: string
  value: string
  delta: { label: string; tone: 'pos' | 'neg' | 'flat' | 'na' }
  prevValue: string
}) {
  return (
    <div className="border border-slate-200 rounded-lg bg-white px-4 py-3">
      <div className="text-sm text-slate-500 uppercase tracking-wide font-medium">
        {label}
      </div>
      <div className="mt-1 flex items-baseline justify-between gap-2 flex-wrap">
        <div className="text-[22px] font-semibold text-slate-900 tabular-nums">
          {value}
        </div>
        <DeltaPill delta={delta} />
      </div>
      <div className="mt-1 text-xs text-slate-400">
        {t('overview.kpi.prev')}{' '}
        <span className="tabular-nums">{prevValue}</span>
      </div>
    </div>
  )
}

function DeltaPill({
  delta,
}: {
  delta: { label: string; tone: 'pos' | 'neg' | 'flat' | 'na' }
}) {
  const tone =
    delta.tone === 'pos'
      ? 'bg-emerald-50 text-emerald-700 border-emerald-200'
      : delta.tone === 'neg'
      ? 'bg-rose-50 text-rose-700 border-rose-200'
      : 'bg-slate-50 text-slate-500 border-slate-200'
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
