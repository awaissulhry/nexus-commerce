'use client'

import {
  Area,
  AreaChart,
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
  Legend,
} from 'recharts'
import { formatCurrency, formatNum, NUM_FMT } from '../format'
import type { MultiSeriesPoint } from '../types'

export interface TrendSeries {
  key: string
  label: string
  color: string
  dashed?: boolean
  format?: 'currency' | 'number'
  yAxisId?: 'left' | 'right'
}

interface TrendChartProps {
  data: MultiSeriesPoint[]
  series: TrendSeries[]
  variant?: 'area' | 'line'
  height?: number
  currency?: string
  xKey?: string
  ariaLabel?: string
  showLegend?: boolean
  rightAxisFormat?: 'currency' | 'number' | 'percent'
}

const PALETTE = [
  'rgb(16 185 129)',
  'rgb(59 130 246)',
  'rgb(245 158 11)',
  'rgb(139 92 246)',
  'rgb(244 63 94)',
  'rgb(20 184 166)',
]

export function trendColor(i: number): string {
  return PALETTE[i % PALETTE.length] ?? PALETTE[0]!
}

function tickX(raw: string): string {
  if (raw.length >= 13 && raw[10] === 'T') return `${raw.slice(11, 13)}:00`
  if (raw.length >= 10) return raw.slice(5)
  return raw
}

export function TrendChart({
  data,
  series,
  variant = 'area',
  height = 240,
  currency = 'EUR',
  xKey = 'date',
  ariaLabel,
  showLegend = true,
  rightAxisFormat,
}: TrendChartProps) {
  const stride = Math.max(1, Math.ceil(data.length / 8))
  const ChartType = variant === 'area' ? AreaChart : LineChart
  const hasRightAxis = series.some((s) => s.yAxisId === 'right')

  return (
    <div className="w-full" style={{ height }} role="img" aria-label={ariaLabel}>
      <ResponsiveContainer width="100%" height="100%">
        <ChartType data={data} margin={{ top: 8, right: hasRightAxis ? 8 : 12, left: 0, bottom: 0 }}>
          <defs>
            {series.map((s, i) => (
              <linearGradient
                key={s.key}
                id={`ih-trend-${s.key}-${i}`}
                x1="0"
                y1="0"
                x2="0"
                y2="1"
              >
                <stop offset="0%" stopColor={s.color} stopOpacity={0.25} />
                <stop offset="100%" stopColor={s.color} stopOpacity={0} />
              </linearGradient>
            ))}
          </defs>
          <CartesianGrid
            strokeDasharray="3 3"
            stroke="rgb(241 245 249)"
            className="dark:[&_line]:stroke-slate-800"
            vertical={false}
          />
          <XAxis
            dataKey={xKey}
            tickLine={false}
            axisLine={false}
            tick={{ fontSize: 11, fill: 'currentColor' }}
            tickFormatter={tickX}
            interval={stride - 1}
            className="text-slate-500 dark:text-slate-400"
          />
          <YAxis
            yAxisId="left"
            tickLine={false}
            axisLine={false}
            tick={{ fontSize: 11, fill: 'currentColor' }}
            tickFormatter={(v: number) => {
              const leftPrimary = series.find(
                (s) => (s.yAxisId ?? 'left') === 'left',
              )
              if (leftPrimary?.format === 'currency') {
                return formatCurrency(v, currency).replace(/[^\d€$£,.kKMm]/g, '')
              }
              return NUM_FMT.format(v)
            }}
            width={52}
            className="text-slate-500 dark:text-slate-400"
          />
          {hasRightAxis && (
            <YAxis
              yAxisId="right"
              orientation="right"
              tickLine={false}
              axisLine={false}
              tick={{ fontSize: 11, fill: 'currentColor' }}
              tickFormatter={(v: number) => {
                if (rightAxisFormat === 'currency')
                  return formatCurrency(v, currency).replace(/[^\d€$£,.kKMm]/g, '')
                if (rightAxisFormat === 'percent') return `${v.toFixed(0)}%`
                return NUM_FMT.format(v)
              }}
              width={48}
              className="text-slate-500 dark:text-slate-400"
            />
          )}
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
              const v = Number(value ?? 0)
              const def = series.find((s) => s.key === String(name))
              const label = def?.label ?? String(name)
              const fmt =
                def?.format === 'currency'
                  ? formatCurrency(v, currency)
                  : formatNum(v)
              return [fmt, label]
            }}
            labelFormatter={(raw) => String(raw ?? '')}
            cursor={{ stroke: 'rgb(148 163 184)', strokeDasharray: '3 3' }}
          />
          {showLegend && series.length > 1 && (
            <Legend
              verticalAlign="top"
              height={24}
              iconType="plainline"
              wrapperStyle={{ fontSize: 11 }}
              formatter={(value) => {
                const def = series.find((s) => s.key === String(value))
                return def?.label ?? String(value)
              }}
            />
          )}
          {series.map((s, i) => {
            if (variant === 'area') {
              return (
                <Area
                  key={s.key}
                  yAxisId={s.yAxisId ?? 'left'}
                  type="monotone"
                  dataKey={s.key}
                  stroke={s.color}
                  strokeWidth={1.75}
                  strokeDasharray={s.dashed ? '4 3' : undefined}
                  fill={`url(#ih-trend-${s.key}-${i})`}
                  dot={false}
                  activeDot={{ r: 3, strokeWidth: 0 }}
                  isAnimationActive={false}
                />
              )
            }
            return (
              <Line
                key={s.key}
                yAxisId={s.yAxisId ?? 'left'}
                type="monotone"
                dataKey={s.key}
                stroke={s.color}
                strokeWidth={1.75}
                strokeDasharray={s.dashed ? '4 3' : undefined}
                dot={false}
                isAnimationActive={false}
              />
            )
          })}
        </ChartType>
      </ResponsiveContainer>
    </div>
  )
}
