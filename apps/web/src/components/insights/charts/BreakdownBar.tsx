'use client'

import { cn } from '@/lib/utils'
import { formatCurrency, formatNum, formatPct } from '../format'
import type { BreakdownEntry } from '../types'

interface BreakdownBarProps {
  entries: BreakdownEntry[]
  format?: 'currency' | 'number' | 'percent'
  currency?: string
  total?: number
  showShare?: boolean
  showDelta?: boolean
  emptyLabel?: string
  maxRows?: number
  onSelect?: (key: string) => void
}

const DEFAULT_COLORS = [
  'bg-emerald-500',
  'bg-blue-500',
  'bg-amber-500',
  'bg-violet-500',
  'bg-rose-500',
  'bg-teal-500',
  'bg-slate-500',
]

export function BreakdownBar({
  entries,
  format = 'currency',
  currency = 'EUR',
  total,
  showShare = true,
  showDelta = true,
  emptyLabel = 'No data',
  maxRows,
  onSelect,
}: BreakdownBarProps) {
  if (entries.length === 0) {
    return (
      <div className="text-sm text-slate-500 dark:text-slate-400 py-8 text-center">
        {emptyLabel}
      </div>
    )
  }

  const sorted = [...entries].sort((a, b) => b.value - a.value)
  const sum = total ?? sorted.reduce((s, e) => s + e.value, 0)
  const max = Math.max(...sorted.map((e) => e.value), 1)
  const rows = maxRows ? sorted.slice(0, maxRows) : sorted

  function fmt(v: number): string {
    if (format === 'currency') return formatCurrency(v, currency)
    if (format === 'percent') return formatPct(v)
    return formatNum(v)
  }

  return (
    <ul className="space-y-1.5">
      {rows.map((entry, i) => {
        const widthPct = Math.max(2, (entry.value / max) * 100)
        const sharePct = sum > 0 ? (entry.value / sum) * 100 : 0
        const color = entry.color ?? DEFAULT_COLORS[i % DEFAULT_COLORS.length]
        const interactive = !!onSelect
        return (
          <li
            key={entry.key}
            className={cn(
              'group grid grid-cols-[120px_1fr_auto] items-center gap-3 text-xs',
              interactive && 'cursor-pointer',
            )}
            onClick={() => onSelect?.(entry.key)}
          >
            <div
              className="truncate text-slate-700 dark:text-slate-300 font-medium"
              title={entry.label}
            >
              {entry.label}
            </div>
            <div className="relative h-5 rounded-sm bg-slate-100 dark:bg-slate-800 overflow-hidden">
              <div
                className={cn('absolute inset-y-0 left-0 rounded-sm', color)}
                style={{ width: `${widthPct}%` }}
              />
              {showShare && (
                <span className="absolute inset-0 flex items-center px-2 text-[10px] font-semibold text-white mix-blend-difference">
                  {sharePct.toFixed(1)}%
                </span>
              )}
            </div>
            <div className="flex items-center gap-2 tabular-nums text-slate-700 dark:text-slate-200">
              <span className="font-semibold">{fmt(entry.value)}</span>
              {showDelta && entry.delta != null && (
                <span
                  className={cn(
                    'text-[10px] font-semibold',
                    entry.delta > 0
                      ? 'text-emerald-600 dark:text-emerald-400'
                      : entry.delta < 0
                        ? 'text-rose-600 dark:text-rose-400'
                        : 'text-tertiary',
                  )}
                >
                  {entry.delta > 0 ? '+' : ''}
                  {entry.delta.toFixed(1)}%
                </span>
              )}
            </div>
          </li>
        )
      })}
    </ul>
  )
}
