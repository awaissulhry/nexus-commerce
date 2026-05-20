'use client'

import {
  Cell,
  Legend,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
} from 'recharts'
import { formatCurrency, formatNum } from '../format'
import type { BreakdownEntry } from '../types'

const PALETTE = [
  'rgb(16 185 129)',
  'rgb(59 130 246)',
  'rgb(245 158 11)',
  'rgb(139 92 246)',
  'rgb(244 63 94)',
  'rgb(20 184 166)',
  'rgb(100 116 139)',
]

interface BreakdownPieProps {
  entries: BreakdownEntry[]
  variant?: 'donut' | 'pie'
  format?: 'currency' | 'number'
  currency?: string
  height?: number
  ariaLabel?: string
  centerLabel?: string
  centerValue?: string
}

export function BreakdownPie({
  entries,
  variant = 'donut',
  format = 'currency',
  currency = 'EUR',
  height = 220,
  ariaLabel,
  centerLabel,
  centerValue,
}: BreakdownPieProps) {
  if (entries.length === 0) {
    return (
      <div
        className="text-sm text-slate-500 dark:text-slate-400 text-center"
        style={{ height }}
      >
        No data
      </div>
    )
  }
  return (
    <div className="relative w-full" style={{ height }} role="img" aria-label={ariaLabel}>
      <ResponsiveContainer width="100%" height="100%">
        <PieChart>
          <Pie
            data={entries}
            dataKey="value"
            nameKey="label"
            innerRadius={variant === 'donut' ? '55%' : 0}
            outerRadius="85%"
            paddingAngle={1}
            isAnimationActive={false}
            stroke="none"
          >
            {entries.map((e, i) => (
              <Cell key={e.key} fill={e.color ?? PALETTE[i % PALETTE.length]} />
            ))}
          </Pie>
          <Tooltip
            contentStyle={{
              background: '#fff',
              border: '1px solid rgb(226 232 240)',
              borderRadius: 6,
              fontSize: 12,
              padding: '6px 10px',
            }}
            wrapperClassName="dark:[&>div]:!bg-slate-900 dark:[&>div]:!border-slate-700 dark:[&>div]:!text-slate-100"
            formatter={(value: unknown, name: unknown) => {
              const v = typeof value === 'number' ? value : Number(value ?? 0)
              return [
                format === 'currency'
                  ? formatCurrency(v, currency)
                  : formatNum(v),
                String(name ?? ''),
              ]
            }}
          />
          <Legend
            verticalAlign="bottom"
            height={28}
            iconType="circle"
            wrapperStyle={{ fontSize: 11 }}
          />
        </PieChart>
      </ResponsiveContainer>
      {variant === 'donut' && (centerLabel || centerValue) && (
        <div className="absolute inset-0 flex flex-col items-center justify-center pointer-events-none -mt-3">
          {centerValue && (
            <div className="text-lg font-semibold text-slate-900 dark:text-slate-100 tabular-nums">
              {centerValue}
            </div>
          )}
          {centerLabel && (
            <div className="text-[11px] uppercase tracking-wider text-slate-500 dark:text-slate-400 mt-0.5">
              {centerLabel}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
