'use client'

import { formatCurrency, NUM_FMT } from '../_lib/format'
import type { OverviewPayload, T, WindowKey } from '../_lib/types'

/**
 * Revenue + orders trend chart. Inline-SVG line plot — pre-recharts
 * placeholder; W8 swaps this for an interactive recharts chart with
 * tooltips, axis labels, and comparison overlay.
 */
export default function Sparkline({
  t,
  points,
  currency,
  windowKey,
}: {
  t: T
  points: OverviewPayload['sparkline']
  currency: string
  windowKey: WindowKey
}) {
  const totalRev = points.reduce((s, p) => s + p.revenue, 0)
  const totalOrders = points.reduce((s, p) => s + p.orders, 0)
  const label = t(`overview.windowLabel.${windowKey}`)
  return (
    <div className="border border-slate-200 rounded-lg bg-white px-4 py-3">
      <div className="flex items-center justify-between mb-2">
        <h2 className="text-md font-semibold text-slate-900">
          {t('overview.trend.heading', { label })}
        </h2>
        <div className="text-sm text-slate-500 tabular-nums">
          {formatCurrency(totalRev, currency)} ·{' '}
          {t(
            totalOrders === 1
              ? 'overview.channels.order'
              : 'overview.channels.orderPlural',
            { n: NUM_FMT.format(totalOrders) },
          )}
        </div>
      </div>
      <SvgLineChart t={t} points={points} />
    </div>
  )
}

function SvgLineChart({
  t,
  points,
}: {
  t: T
  points: OverviewPayload['sparkline']
}) {
  const w = 600
  const h = 100
  const pad = 4
  const maxRev = Math.max(1, ...points.map((p) => p.revenue))
  const maxOrd = Math.max(1, ...points.map((p) => p.orders))
  const xStep = (w - pad * 2) / Math.max(1, points.length - 1)
  const yScaleRev = (v: number) => h - pad - ((h - pad * 2) * v) / maxRev
  const yScaleOrd = (v: number) => h - pad - ((h - pad * 2) * v) / maxOrd
  const revPath = points
    .map(
      (p, i) =>
        `${i === 0 ? 'M' : 'L'} ${pad + i * xStep},${yScaleRev(p.revenue)}`,
    )
    .join(' ')
  const ordPath = points
    .map(
      (p, i) =>
        `${i === 0 ? 'M' : 'L'} ${pad + i * xStep},${yScaleOrd(p.orders)}`,
    )
    .join(' ')
  return (
    <div>
      <svg
        viewBox={`0 0 ${w} ${h}`}
        className="w-full h-[100px]"
        role="img"
        aria-label="revenue and orders trend"
      >
        <path
          d={revPath}
          fill="none"
          stroke="rgb(16 185 129)"
          strokeWidth="1.5"
        />
        <path
          d={ordPath}
          fill="none"
          stroke="rgb(59 130 246)"
          strokeWidth="1.5"
          strokeDasharray="2 2"
          opacity="0.6"
        />
      </svg>
      <div className="flex items-center gap-3 mt-1 text-xs text-slate-500">
        <span className="inline-flex items-center gap-1">
          <span className="inline-block w-2 h-0.5 bg-emerald-500" />
          {t('overview.trend.legend.revenue')}
        </span>
        <span className="inline-flex items-center gap-1">
          <span className="inline-block w-2 h-0.5 bg-blue-500 opacity-60" />
          {t('overview.trend.legend.orders')}
        </span>
      </div>
    </div>
  )
}
