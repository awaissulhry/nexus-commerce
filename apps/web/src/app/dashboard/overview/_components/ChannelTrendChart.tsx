'use client'

import {
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'
import { Card } from '@/components/ui/Card'
import { formatCurrency } from '../_lib/format'
import {
  CHANNEL_LABELS,
  type OverviewPayload,
  type T,
  type WindowKey,
} from '../_lib/types'

/**
 * DO.26 — per-channel revenue trend on the same buckets as the
 * primary Sparkline. One line per channel that produced revenue
 * inside the window, keyed by its iconic colour (orange Amazon,
 * blue eBay, emerald Shopify, …) so the operator can spot the
 * channel mix shape at a glance.
 *
 * Data shape: each row in `points` carries a date, the totals,
 * and `channel_<X>: number` columns for each active channel —
 * recharts reads them via dataKey strings.
 *
 * Hidden when only one channel produced revenue (the primary
 * Sparkline already tells that story; a one-line "comparison"
 * chart is duplication).
 */

const CHANNEL_STROKE: Record<string, string> = {
  AMAZON: 'rgb(249 115 22)', // orange-500
  EBAY: 'rgb(59 130 246)', // blue-500
  SHOPIFY: 'rgb(16 185 129)', // emerald-500
  WOOCOMMERCE: 'rgb(139 92 246)', // violet-500
  ETSY: 'rgb(244 63 94)', // rose-500
}

export default function ChannelTrendChart({
  t,
  points,
  channels,
  currency,
  windowKey,
}: {
  t: T
  points: OverviewPayload['sparkline']
  channels: string[]
  currency: string
  windowKey: WindowKey
}) {
  // Hide the chart when there's only one (or zero) revenue-producing
  // channel in the window — the primary Sparkline covers that case.
  const activeChannels = channels.filter((ch) =>
    points.some((p) => Number(p[`channel_${ch}`] ?? 0) > 0),
  )
  if (activeChannels.length < 2) return null

  const isHourly = windowKey === 'today'
  const formatTick = (raw: string): string => {
    if (isHourly) return `${raw.slice(11, 13)}:00`
    return raw.slice(5)
  }
  const stride = Math.max(1, Math.ceil(points.length / 6))

  return (
    <Card title={t('overview.channelTrend.heading')} noPadding>
      <div className="px-4 py-3">
        <div
          className="h-[180px]"
          role="img"
          aria-label={t('overview.channelTrend.heading')}
        >
          <ResponsiveContainer width="100%" height="100%">
            <LineChart
              data={points}
              margin={{ top: 5, right: 8, left: 0, bottom: 0 }}
            >
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
                  background: '#fff',
                  border: '1px solid rgb(226 232 240)',
                  borderRadius: 6,
                  fontSize: 12,
                  padding: '6px 10px',
                }}
                wrapperClassName="dark:[&>div]:!bg-slate-900 dark:[&>div]:!border-slate-700 dark:[&>div]:!text-slate-100"
                formatter={(value, name) => {
                  const ch = String(name).replace(/^channel_/, '')
                  const label = CHANNEL_LABELS[ch] ?? ch
                  return [formatCurrency(Number(value ?? 0), currency), label]
                }}
                labelFormatter={(raw) => String(raw ?? '')}
                cursor={{ stroke: 'rgb(148 163 184)', strokeDasharray: '3 3' }}
              />
              {activeChannels.map((ch) => (
                <Line
                  key={ch}
                  type="monotone"
                  dataKey={`channel_${ch}`}
                  name={`channel_${ch}`}
                  stroke={CHANNEL_STROKE[ch] ?? 'rgb(100 116 139)'}
                  strokeWidth={1.5}
                  dot={false}
                  isAnimationActive={false}
                />
              ))}
            </LineChart>
          </ResponsiveContainer>
        </div>
        <div className="flex items-center gap-3 mt-1 text-xs text-slate-500 dark:text-slate-400 flex-wrap">
          {activeChannels.map((ch) => (
            <span key={ch} className="inline-flex items-center gap-1">
              <span
                className="inline-block w-2 h-0.5"
                style={{
                  backgroundColor: CHANNEL_STROKE[ch] ?? 'rgb(100 116 139)',
                }}
              />
              {CHANNEL_LABELS[ch] ?? ch}
            </span>
          ))}
        </div>
      </div>
    </Card>
  )
}
