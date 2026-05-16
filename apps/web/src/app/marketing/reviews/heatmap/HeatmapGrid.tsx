'use client'

import { useMemo, useState } from 'react'
import Link from 'next/link'
import { CATEGORY_LABEL } from '../_shared/ReviewsNav'

interface Cell {
  date: string
  category: string
  total: number
  positive: number
  neutral: number
  negative: number
}

type Mode = 'volume' | 'rate'

function volumeTone(units: number, max: number): string {
  if (units === 0) return 'bg-slate-50 dark:bg-slate-950/40 text-slate-400 dark:text-slate-600'
  // Quintile bucketing on log scale so small values still show signal.
  const intensity = Math.log(units + 1) / Math.log(Math.max(2, max + 1))
  if (intensity > 0.8) return 'bg-blue-700 text-white dark:bg-blue-500'
  if (intensity > 0.6) return 'bg-blue-500 text-white dark:bg-blue-600'
  if (intensity > 0.4) return 'bg-blue-300 text-blue-900 dark:bg-blue-700 dark:text-blue-100'
  if (intensity > 0.2) return 'bg-blue-100 text-blue-900 dark:bg-blue-900/40 dark:text-blue-300'
  return 'bg-blue-50 text-blue-700 dark:bg-blue-950/40 dark:text-blue-300'
}

function rateTone(negative: number, total: number): string {
  if (total === 0) return 'bg-slate-50 dark:bg-slate-950/40 text-slate-400 dark:text-slate-600'
  const rate = negative / total
  if (rate >= 0.5) return 'bg-rose-700 text-white dark:bg-rose-500'
  if (rate >= 0.3) return 'bg-rose-500 text-white dark:bg-rose-600'
  if (rate >= 0.15) return 'bg-rose-200 text-rose-900 dark:bg-rose-900/60 dark:text-rose-100'
  if (rate > 0) return 'bg-rose-50 text-rose-700 dark:bg-rose-950/40 dark:text-rose-300'
  return 'bg-emerald-50 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300'
}

export function HeatmapGrid({
  dates,
  categories,
  cells,
}: {
  dates: string[]
  categories: string[]
  cells: Cell[]
}) {
  const [mode, setMode] = useState<Mode>('volume')

  const byKey = useMemo(() => {
    const m = new Map<string, Cell>()
    for (const c of cells) m.set(`${c.date}::${c.category}`, c)
    return m
  }, [cells])

  const maxVolume = useMemo(() => cells.reduce((a, c) => Math.max(a, c.total), 0), [cells])

  return (
    <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-md p-3">
      <div className="flex items-center gap-2 mb-3 flex-wrap">
        <span className="text-xs uppercase tracking-wider text-slate-500 dark:text-slate-400">
          Color:
        </span>
        {(['volume', 'rate'] as Mode[]).map((m) => (
          <button
            key={m}
            type="button"
            onClick={() => setMode(m)}
            className={`text-xs px-2 py-1 rounded ring-1 ring-inset ${
              mode === m
                ? 'bg-blue-600 text-white ring-blue-600'
                : 'bg-white dark:bg-slate-900 text-slate-700 dark:text-slate-300 ring-slate-300 dark:ring-slate-700'
            }`}
          >
            {m === 'volume' ? 'Volume' : 'Negative rate'}
          </button>
        ))}
        <span className="ml-auto text-xs text-slate-500 dark:text-slate-400">
          {dates.length} days × {categories.length} categories
        </span>
      </div>

      <div className="overflow-x-auto">
        <table className="text-xs">
          <thead>
            <tr>
              <th className="sticky left-0 bg-white dark:bg-slate-900 px-2 py-1 text-left text-[10px] uppercase tracking-wider text-slate-500 dark:text-slate-400 z-10">
                Category
              </th>
              {dates.map((d) => (
                <th
                  key={d}
                  className="px-1 py-1 text-[10px] font-mono text-slate-500 dark:text-slate-400 text-center min-w-[28px]"
                  title={d}
                >
                  {d.slice(8, 10)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {categories.map((cat) => (
              <tr key={cat}>
                <th className="sticky left-0 bg-white dark:bg-slate-900 px-2 py-1 text-left font-medium text-slate-700 dark:text-slate-300 z-10">
                  {CATEGORY_LABEL[cat] ?? cat}
                </th>
                {dates.map((d) => {
                  const cell = byKey.get(`${d}::${cat}`)
                  const cls = !cell
                    ? volumeTone(0, maxVolume)
                    : mode === 'volume'
                      ? volumeTone(cell.total, maxVolume)
                      : rateTone(cell.negative, cell.total)
                  const label = cell
                    ? mode === 'volume'
                      ? cell.total
                      : cell.total > 0
                        ? `${Math.round((cell.negative / cell.total) * 100)}%`
                        : '—'
                    : ''
                  return (
                    <td key={d} className="px-0.5 py-0.5">
                      <Link
                        href={`/marketing/reviews?category=${cat}&sinceDays=30`}
                        className={`block rounded text-center py-1 px-0.5 font-mono text-[10px] ${cls} hover:opacity-80`}
                        title={
                          cell
                            ? `${d} · ${CATEGORY_LABEL[cat] ?? cat} · total ${cell.total} · neg ${cell.negative} · pos ${cell.positive}`
                            : 'no data'
                        }
                      >
                        {label}
                      </Link>
                    </td>
                  )
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="mt-2 text-[11px] text-slate-500 dark:text-slate-400">
        Click a cell → feed filtered by category. &quot;Negative rate&quot; mode surfaces issues
        even on low volumes.
      </div>
    </div>
  )
}
