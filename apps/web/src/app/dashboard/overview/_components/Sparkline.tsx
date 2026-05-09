'use client'

import {
  Area,
  AreaChart,
  CartesianGrid,
  Line,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'
import { Card } from '@/components/ui/Card'
import { formatCurrency, NUM_FMT } from '../_lib/format'
import type { OverviewPayload, T, WindowKey } from '../_lib/types'

/**
 * Revenue + orders trend chart.
 *
 * DO.24 — replaces the previous inline-SVG path with a `recharts`
 * AreaChart so hovering surfaces per-bucket numbers, the X axis
 * sparsely labels dates, and the Y axis carries currency-formatted
 * gridlines. The orders line overlays as a secondary series
 * scaled to its own implied range (visually parallel only — for a
 * proper dual-axis we'd need a right-hand YAxis, deferred to DO.26
 * when channel comparison ships).
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

  // Hourly bucketing in 'today' mode produces YYYY-MM-DDTHH; trim
  // to "HH:00" for the X axis label so the chart reads cleanly. All
  // other windows use YYYY-MM-DD; we render "MM-DD" for compactness.
  const isHourly = windowKey === 'today'
  const formatTick = (raw: string): string => {
    if (isHourly) return `${raw.slice(11, 13)}:00`
    return raw.slice(5) // MM-DD
  }

  // Sparse X-axis: only render every Nth tick so labels don't
  // overlap on tight windows. Aim for ~6 visible labels.
  const stride = Math.max(1, Math.ceil(points.length / 6))

  return (
    <Card
      title={t('overview.trend.heading', { label })}
      action={
        <div className="text-sm text-slate-500 dark:text-slate-400 tabular-nums">
          {formatCurrency(totalRev, currency)} ·{' '}
          {t(
            totalOrders === 1
              ? 'overview.channels.order'
              : 'overview.channels.orderPlural',
            { n: NUM_FMT.format(totalOrders) },
          )}
        </div>
      }
      noPadding
    >
      <div className="px-4 py-3">
        <div className="h-[180px]">
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart
              data={points}
              margin={{ top: 5, right: 8, left: 0, bottom: 0 }}
            >
              <defs>
                <linearGradient
                  id="overview-spark-revenue"
                  x1="0"
                  y1="0"
                  x2="0"
                  y2="1"
                >
                  <stop offset="0%" stopColor="rgb(16 185 129)" stopOpacity={0.25} />
                  <stop offset="100%" stopColor="rgb(16 185 129)" stopOpacity={0} />
                </linearGradient>
              </defs>
              <CartesianGrid
                strokeDasharray="3 3"
                stroke="rgb(241 245 249)"
                className="dark:[&_line]:stroke-slate-800"
                vertical={false}
              />
              <XAxis
                dataKey="date"
                tickLine={false}
                axisLine={false}
                tick={{ fontSize: 11, fill: 'currentColor' }}
                tickFormatter={formatTick}
                interval={stride - 1}
                className="text-slate-500 dark:text-slate-400"
              />
              <YAxis
                yAxisId="rev"
                tickLine={false}
                axisLine={false}
                tick={{ fontSize: 11, fill: 'currentColor' }}
                tickFormatter={(v: number) =>
                  formatCurrency(v, currency).replace(/[^\d€$£,.kKMm]/g, '')
                }
                width={48}
                className="text-slate-500 dark:text-slate-400"
              />
              <Tooltip
                contentStyle={{
                  background: 'var(--tw-prose-bg, #fff)',
                  border: '1px solid rgb(226 232 240)',
                  borderRadius: 6,
                  fontSize: 12,
                  padding: '6px 10px',
                }}
                wrapperClassName="dark:[&>div]:!bg-slate-900 dark:[&>div]:!border-slate-700 dark:[&>div]:!text-slate-100"
                formatter={(value, name) => {
                  const v = Number(value ?? 0)
                  if (name === 'revenue') {
                    return [
                      formatCurrency(v, currency),
                      t('overview.trend.legend.revenue'),
                    ]
                  }
                  return [
                    NUM_FMT.format(v),
                    t('overview.trend.legend.orders'),
                  ]
                }}
                labelFormatter={(raw) => String(raw ?? '')}
                cursor={{ stroke: 'rgb(148 163 184)', strokeDasharray: '3 3' }}
              />
              <Area
                yAxisId="rev"
                type="monotone"
                dataKey="revenue"
                stroke="rgb(16 185 129)"
                strokeWidth={1.75}
                fill="url(#overview-spark-revenue)"
                dot={false}
                activeDot={{ r: 3, strokeWidth: 0 }}
                isAnimationActive={false}
              />
              <Line
                yAxisId="rev"
                type="monotone"
                dataKey="orders"
                stroke="rgb(59 130 246)"
                strokeWidth={1.5}
                strokeDasharray="3 3"
                dot={false}
                isAnimationActive={false}
                opacity={0.65}
              />
            </AreaChart>
          </ResponsiveContainer>
        </div>
        <div className="flex items-center gap-3 mt-1 text-xs text-slate-500 dark:text-slate-400">
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
    </Card>
  )
}
