'use client'

/**
 * CD.4 — Budget pace & projection.
 *
 * Derives the campaign's budget pacing from the campaign-scoped daily trend
 * rows the cockpit already fetched (no extra round-trip). Amazon ad-spend
 * reports are daily-grain (T+1), so this works on trailing daily spend rather
 * than an intraday clock: trailing-7d average daily spend vs daily budget,
 * budget-constrained-days signal (days at/over cap = lost impressions), and a
 * 30-day run-rate projection. The true intraday "exhausts at HH:MM today"
 * clock lands in CD.12 once the hourly store (CD.11) exists.
 */

import type { TrendRow } from './CampaignTrendChart'

const eur0 = (c: number) => new Intl.NumberFormat('en-IE', { style: 'currency', currency: 'EUR', maximumFractionDigits: 0 }).format(c / 100)

export function CampaignBudgetPace({ rows, dailyBudget, windowDays }: { rows: TrendRow[] | null; dailyBudget: string; windowDays: number }) {
  const budgetCents = Math.round(parseFloat(dailyBudget || '0') * 100)
  if (!rows || rows.length === 0 || budgetCents <= 0) return null

  const last7 = rows.slice(-7)
  const avgDaily = last7.reduce((s, r) => s + r.adSpendCents, 0) / last7.length
  const util = avgDaily / budgetCents // fraction of daily budget used on average
  // A day is "budget-constrained" when spend reached ~95%+ of the cap — Amazon
  // throttled delivery, so impressions were likely left on the table.
  const constrainedDays = rows.filter((r) => r.adSpendCents >= budgetCents * 0.95).length
  const runRate30 = avgDaily * 30

  const tone = util >= 0.95 || constrainedDays >= Math.max(2, Math.ceil(rows.length * 0.3))
    ? 'rose'
    : util >= 0.85
      ? 'amber'
      : 'emerald'
  const barColor = tone === 'rose' ? 'bg-rose-500' : tone === 'amber' ? 'bg-amber-500' : 'bg-emerald-500'
  const fillPct = Math.min(100, Math.round(util * 100))

  return (
    <div className="mb-4 rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-950 p-3">
      <div className="flex items-center justify-between text-xs mb-1.5">
        <span className="font-medium text-slate-600 dark:text-slate-300">Budget pace</span>
        <span className="text-slate-500">
          avg <span className="tabular-nums font-medium text-slate-700 dark:text-slate-200">{eur0(avgDaily)}</span> / {eur0(budgetCents)} per day
          <span className="ml-1 text-slate-400">({fillPct}%)</span>
        </span>
      </div>
      <div className="h-2 w-full rounded-full bg-slate-100 dark:bg-slate-800 overflow-hidden">
        <div className={`h-full rounded-full ${barColor}`} style={{ width: `${fillPct}%` }} />
      </div>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 mt-2 text-xs text-slate-500">
        {constrainedDays > 0 && (
          <span className={tone === 'rose' ? 'text-rose-600 dark:text-rose-400 font-medium' : 'text-amber-600 dark:text-amber-400'}>
            Budget-constrained {constrainedDays} of {rows.length} day{rows.length === 1 ? '' : 's'}{tone === 'rose' ? ' — raise budget to capture lost impressions' : ''}
          </span>
        )}
        <span>Run-rate ~<span className="tabular-nums font-medium text-slate-700 dark:text-slate-200">{eur0(runRate30)}</span>/30d</span>
        <span className="text-slate-400">over last {Math.min(windowDays, rows.length)}d</span>
      </div>
    </div>
  )
}
