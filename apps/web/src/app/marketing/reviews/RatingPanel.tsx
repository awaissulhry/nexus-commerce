/**
 * RX.0 — Star-rating panel.
 *
 * Average rating (with star glyphs), 1–5 distribution bars, and a daily
 * average-rating sparkline. Server-rendered from /api/reviews/ratings.
 * Every best-in-class review tool leads with this; the SR dashboards
 * tracked sentiment labels but never the raw star distribution.
 */

import { Star } from 'lucide-react'

export interface RatingsPayload {
  sinceDays: number
  marketplace: string | null
  average: number | null
  count: number
  distribution: Record<string, number>
  trend: { date: string; avg: number | null; count: number }[]
}

function Stars({ value }: { value: number }) {
  // Render five star glyphs, partially filling the fractional one.
  return (
    <div className="inline-flex items-center" aria-hidden="true">
      {[0, 1, 2, 3, 4].map((i) => {
        const fill = Math.max(0, Math.min(1, value - i))
        return (
          <span key={i} className="relative inline-block h-4 w-4">
            <Star className="absolute inset-0 h-4 w-4 text-slate-300 dark:text-slate-700" />
            <span
              className="absolute inset-0 overflow-hidden"
              style={{ width: `${fill * 100}%` }}
            >
              <Star className="h-4 w-4 fill-amber-400 text-amber-400" />
            </span>
          </span>
        )
      })}
    </div>
  )
}

function Sparkline({ trend }: { trend: RatingsPayload['trend'] }) {
  const points = trend.filter((t) => t.avg != null) as {
    date: string
    avg: number
    count: number
  }[]
  if (points.length < 2) return null
  const w = 280
  const h = 36
  const min = 1
  const max = 5
  const step = points.length > 1 ? w / (points.length - 1) : w
  const path = points
    .map((p, i) => {
      const x = i * step
      const y = h - ((p.avg - min) / (max - min)) * h
      return `${i === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`
    })
    .join(' ')
  return (
    <svg
      viewBox={`0 0 ${w} ${h}`}
      className="w-full h-9"
      preserveAspectRatio="none"
      role="img"
      aria-label="Average rating trend"
    >
      <path d={path} fill="none" stroke="currentColor" strokeWidth={1.5} className="text-amber-500 dark:text-amber-400" />
    </svg>
  )
}

const STAR_TONE: Record<number, string> = {
  5: 'bg-emerald-500',
  4: 'bg-emerald-400',
  3: 'bg-amber-400',
  2: 'bg-orange-400',
  1: 'bg-rose-500',
}

export function RatingPanel({ ratings }: { ratings: RatingsPayload }) {
  const total = Object.values(ratings.distribution).reduce((a, b) => a + (b ?? 0), 0)
  return (
    <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-md">
      <div className="px-3 py-2 border-b border-slate-200 dark:border-slate-800 flex items-center gap-2">
        <Star className="h-4 w-4 text-amber-500 dark:text-amber-400" />
        <div className="text-sm font-medium text-slate-900 dark:text-slate-100">
          Star ratings
        </div>
        <span className="text-xs text-slate-500 dark:text-slate-400">
          {ratings.sinceDays}d · {total}
        </span>
      </div>
      <div className="px-3 py-3">
        {ratings.average == null || total === 0 ? (
          <div className="text-sm text-slate-500 dark:text-slate-400 py-2">
            No rated reviews in this window.
          </div>
        ) : (
          <>
            <div className="flex items-end gap-2 mb-3">
              <div className="text-3xl font-semibold tabular-nums text-slate-900 dark:text-slate-100 leading-none">
                {ratings.average.toFixed(2)}
              </div>
              <div className="pb-0.5">
                <Stars value={ratings.average} />
                <div className="text-[10px] text-slate-500 dark:text-slate-400 mt-0.5">
                  {total} rated review{total === 1 ? '' : 's'}
                </div>
              </div>
            </div>

            {/* Distribution bars, 5 → 1 */}
            <div className="space-y-1 mb-3">
              {[5, 4, 3, 2, 1].map((star) => {
                const c = ratings.distribution[String(star)] ?? 0
                const pct = total > 0 ? (c / total) * 100 : 0
                return (
                  <div key={star} className="flex items-center gap-2">
                    <span className="text-[11px] tabular-nums text-slate-500 dark:text-slate-400 w-6 text-right">
                      {star}★
                    </span>
                    <div className="flex-1 h-2 rounded-full bg-slate-100 dark:bg-slate-800 overflow-hidden">
                      <div
                        className={`h-full ${STAR_TONE[star]} rounded-full`}
                        style={{ width: `${pct}%` }}
                      />
                    </div>
                    <span className="text-[11px] tabular-nums text-slate-500 dark:text-slate-400 w-8">
                      {c}
                    </span>
                  </div>
                )
              })}
            </div>

            {/* Trend sparkline */}
            <div>
              <div className="text-[10px] uppercase tracking-wider text-slate-500 dark:text-slate-400 mb-0.5">
                Avg trend
              </div>
              <Sparkline trend={ratings.trend} />
            </div>
          </>
        )}
      </div>
    </div>
  )
}
