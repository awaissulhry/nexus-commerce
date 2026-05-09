'use client'

import { Calendar } from 'lucide-react'
import { Card } from '@/components/ui/Card'
import { cn } from '@/lib/utils'
import { formatCurrency } from '../_lib/format'
import type { T } from '../_lib/types'

/**
 * DO.42 — Day-of-week × hour-of-day revenue density.
 *
 * 7 × 24 grid; row = day (Mon..Sun), column = hour (00..23 in
 * Europe/Rome). Cell intensity is proportional to that bucket's
 * share of the window's total revenue. Hover surfaces the exact
 * value via title.
 *
 * Why a heatmap and not a chart: the operator's question here is
 * "when do customers buy?" — a two-dimensional density question.
 * A line chart hides the day-vs-hour axis interaction; a heatmap
 * makes "Saturday afternoons are golden, Tuesday mornings dead"
 * jump out without reading anything.
 *
 * Hidden when the window has no revenue at all — empty grid is
 * just visual noise.
 */

const HOURS_PER_LABEL = 4 // show 00, 04, 08, 12, 16, 20

export default function HeatmapPanel({
  t,
  heatmap,
  currency,
}: {
  t: T
  heatmap: number[][]
  currency: string
}) {
  const flat = heatmap.flat()
  const max = Math.max(0, ...flat)
  if (max <= 0) return null

  const dayKeys = [
    'overview.heatmap.day.mon',
    'overview.heatmap.day.tue',
    'overview.heatmap.day.wed',
    'overview.heatmap.day.thu',
    'overview.heatmap.day.fri',
    'overview.heatmap.day.sat',
    'overview.heatmap.day.sun',
  ]

  return (
    <Card
      title={
        <span className="inline-flex items-center gap-1.5">
          <Calendar className="w-3.5 h-3.5 text-slate-400" />
          {t('overview.heatmap.heading')}
        </span>
      }
    >
      <div className="overflow-x-auto">
        <table
          className="border-separate"
          style={{ borderSpacing: '2px' }}
          role="presentation"
          aria-label={t('overview.heatmap.heading')}
        >
          <thead>
            <tr>
              <th className="w-10"></th>
              {Array.from({ length: 24 }).map((_, h) => (
                <th
                  key={h}
                  className="text-[10px] font-mono text-slate-400 dark:text-slate-500 text-center font-normal"
                  style={{ minWidth: 14 }}
                >
                  {h % HOURS_PER_LABEL === 0 ? String(h).padStart(2, '0') : ''}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {heatmap.map((row, d) => (
              <tr key={d}>
                <td className="text-xs font-medium text-slate-500 dark:text-slate-400 pr-2 text-right whitespace-nowrap">
                  {t(dayKeys[d])}
                </td>
                {row.map((value, h) => {
                  const ratio = value / max
                  return (
                    <td
                      key={h}
                      title={
                        value > 0
                          ? `${t(dayKeys[d])} ${String(h).padStart(2, '0')}:00 — ${formatCurrency(value, currency)}`
                          : undefined
                      }
                      className={cn(
                        'rounded-sm transition-colors',
                        ratio === 0 &&
                          'bg-slate-100 dark:bg-slate-800/50',
                      )}
                      style={{
                        width: 14,
                        height: 14,
                        backgroundColor:
                          ratio > 0
                            ? heatColor(ratio)
                            : undefined,
                      }}
                      aria-label={
                        value > 0
                          ? `${t(dayKeys[d])} ${String(h).padStart(2, '0')}:00 ${formatCurrency(value, currency)}`
                          : undefined
                      }
                    />
                  )
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Scale legend */}
      <div className="mt-3 flex items-center gap-2 text-xs text-slate-500 dark:text-slate-400">
        <span>{t('overview.heatmap.legendLow')}</span>
        <div className="flex items-center gap-px">
          {[0.15, 0.3, 0.5, 0.7, 0.9].map((r) => (
            <div
              key={r}
              className="rounded-sm"
              style={{
                width: 12,
                height: 12,
                backgroundColor: heatColor(r),
              }}
            />
          ))}
        </div>
        <span>{t('overview.heatmap.legendHigh')}</span>
        <span className="ml-auto tabular-nums">
          {t('overview.heatmap.peak', { amount: formatCurrency(max, currency) })}
        </span>
      </div>
    </Card>
  )
}

/**
 * Map a 0..1 ratio to an emerald-ish gradient. Picks low-end /
 * mid / high-end colors and lerps; matches the dashboard's
 * accent so the heatmap reads as part of the same surface.
 */
function heatColor(ratio: number): string {
  const r = Math.max(0, Math.min(1, ratio))
  // emerald-100 → emerald-500 → emerald-700
  const stops: Array<[number, [number, number, number]]> = [
    [0, [220, 252, 231]], // emerald-100
    [0.5, [16, 185, 129]], // emerald-500
    [1, [4, 120, 87]], // emerald-700
  ]
  let lo = stops[0]
  let hi = stops[stops.length - 1]
  for (let i = 0; i < stops.length - 1; i++) {
    if (r >= stops[i][0] && r <= stops[i + 1][0]) {
      lo = stops[i]
      hi = stops[i + 1]
      break
    }
  }
  const [t0, c0] = lo
  const [t1, c1] = hi
  const span = t1 - t0 || 1
  const localR = (r - t0) / span
  const c = c0.map((v, i) => Math.round(v + (c1[i] - v) * localR))
  return `rgb(${c[0]} ${c[1]} ${c[2]})`
}
