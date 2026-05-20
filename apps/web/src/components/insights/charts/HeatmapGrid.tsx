'use client'

import { cn } from '@/lib/utils'
import { formatCurrency, formatNum } from '../format'

export interface HeatmapCell {
  row: string
  col: string
  value: number
}

interface HeatmapGridProps {
  cells: HeatmapCell[]
  rows: { key: string; label: string }[]
  cols: { key: string; label: string }[]
  format?: 'currency' | 'number'
  currency?: string
  emptyLabel?: string
  ariaLabel?: string
}

function toneFor(ratio: number): string {
  if (ratio === 0) return 'bg-slate-50 dark:bg-slate-900 text-slate-400'
  if (ratio < 0.15) return 'bg-emerald-50 dark:bg-emerald-950/40 text-emerald-900 dark:text-emerald-200'
  if (ratio < 0.35) return 'bg-emerald-100 dark:bg-emerald-900/50 text-emerald-900 dark:text-emerald-100'
  if (ratio < 0.6) return 'bg-emerald-300 dark:bg-emerald-800/70 text-emerald-950 dark:text-emerald-50'
  if (ratio < 0.85) return 'bg-emerald-500 text-white'
  return 'bg-emerald-700 text-white'
}

export function HeatmapGrid({
  cells,
  rows,
  cols,
  format = 'currency',
  currency = 'EUR',
  ariaLabel,
}: HeatmapGridProps) {
  const map = new Map<string, number>()
  let max = 0
  for (const c of cells) {
    map.set(`${c.row}|${c.col}`, c.value)
    if (c.value > max) max = c.value
  }

  function fmt(v: number): string {
    return format === 'currency' ? formatCurrency(v, currency) : formatNum(v)
  }

  return (
    <div
      className="overflow-x-auto"
      role="table"
      aria-label={ariaLabel ?? 'Heatmap'}
    >
      <table className="min-w-full text-xs border-separate border-spacing-[2px]">
        <thead>
          <tr>
            <th className="text-left text-slate-500 dark:text-slate-400 font-medium px-2 py-1 sticky left-0 bg-white dark:bg-slate-900 z-10">
              {/* corner */}
            </th>
            {cols.map((c) => (
              <th
                key={c.key}
                className="text-center text-slate-500 dark:text-slate-400 font-medium px-2 py-1 whitespace-nowrap"
                title={c.label}
              >
                {c.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.key}>
              <th
                className="text-left text-slate-700 dark:text-slate-200 font-medium px-2 py-1 whitespace-nowrap sticky left-0 bg-white dark:bg-slate-900 z-10"
                title={r.label}
              >
                {r.label}
              </th>
              {cols.map((c) => {
                const v = map.get(`${r.key}|${c.key}`) ?? 0
                const ratio = max > 0 ? v / max : 0
                return (
                  <td
                    key={c.key}
                    className={cn(
                      'text-center tabular-nums px-2 py-1 rounded-sm transition',
                      toneFor(ratio),
                    )}
                    title={`${r.label} · ${c.label}: ${fmt(v)}`}
                  >
                    {v === 0 ? '—' : fmt(v)}
                  </td>
                )
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
