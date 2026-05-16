/**
 * SR.2 — Day × category sentiment heatmap.
 *
 * Volume mode: cell intensity = log(total). Operator can flip to "rate"
 * mode to color by negative percentage instead. Click-through drills
 * into the underlying reviews for that (day, category) cohort.
 */

import { Grid } from 'lucide-react'
import { getBackendUrl } from '@/lib/backend-url'
import { ReviewsNav } from '../_shared/ReviewsNav'
import { HeatmapGrid } from './HeatmapGrid'

export const dynamic = 'force-dynamic'

interface HeatmapCell {
  date: string
  category: string
  total: number
  positive: number
  neutral: number
  negative: number
}

interface HeatmapResponse {
  dates: string[]
  categories: string[]
  cells: HeatmapCell[]
  sinceDays: number
  marketplace: string | null
}

async function fetchHeatmap(): Promise<HeatmapResponse> {
  try {
    const res = await fetch(`${getBackendUrl()}/api/reviews/heatmap?sinceDays=30`, {
      cache: 'no-store',
    })
    if (!res.ok) throw new Error()
    return (await res.json()) as HeatmapResponse
  } catch {
    return { dates: [], categories: [], cells: [], sinceDays: 30, marketplace: null }
  }
}

export default async function HeatmapPage() {
  const data = await fetchHeatmap()
  const totalReviews = data.cells.reduce((acc, c) => acc + c.total, 0)
  const totalNegative = data.cells.reduce((acc, c) => acc + c.negative, 0)

  return (
    <div className="px-4 py-4">
      <div className="flex items-start gap-3 mb-3">
        <Grid className="h-6 w-6 text-blue-500 dark:text-blue-400 mt-0.5" />
        <div className="flex-1">
          <h1 className="text-xl font-semibold text-slate-900 dark:text-slate-100">
            Sentiment Heatmap
          </h1>
          <p className="text-sm text-slate-500 dark:text-slate-400">
            Volume and negative review rate by day × category. Hotter cells indicate spikes —
            cross-reference with the Spikes feed to see if an alert is already active.
          </p>
        </div>
      </div>
      <ReviewsNav />

      <div className="grid grid-cols-1 md:grid-cols-3 gap-3 mb-4">
        <Stat label="Reviews in period" value={totalReviews} />
        <Stat label="Active categories" value={data.categories.length} />
        <Stat
          label="Total negative"
          value={totalNegative}
          tone={totalNegative > 0 ? 'rose' : null}
        />
      </div>

      {data.cells.length === 0 ? (
        <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-md px-4 py-6 text-center text-sm text-slate-500">
          No data in {data.sinceDays} days. Run the ingest:{' '}
          <code className="px-1 py-0.5 rounded bg-slate-100 dark:bg-slate-800">
            POST /api/reviews/cron/ingest/trigger
          </code>
        </div>
      ) : (
        <HeatmapGrid dates={data.dates} categories={data.categories} cells={data.cells} />
      )}
    </div>
  )
}

function Stat({
  label,
  value,
  tone,
}: {
  label: string
  value: number | string
  tone?: 'rose' | null
}) {
  return (
    <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-md px-3 py-2">
      <div className="text-[10px] uppercase tracking-wider text-slate-500 dark:text-slate-400">
        {label}
      </div>
      <div
        className={`text-base font-semibold tabular-nums ${
          tone === 'rose'
            ? 'text-rose-700 dark:text-rose-300'
            : 'text-slate-900 dark:text-slate-100'
        }`}
      >
        {value}
      </div>
    </div>
  )
}
