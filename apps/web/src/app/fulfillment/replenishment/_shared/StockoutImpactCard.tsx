'use client'

/**
 * W9.6f — Stockout impact card (R.12 origin).
 *
 * Extracted from ReplenishmentWorkspace.tsx. Workspace-level summary
 * of YTD/30d stockouts + estimated lost margin/revenue. Renders only
 * when there's data; silent during pre-launch when nothing's actually
 * stocked out.
 *
 * Adds dark-mode classes throughout the chrome (background, header,
 * lost-margin tone, refresh button surface).
 */

import { useEffect, useState } from 'react'
import { RefreshCw } from 'lucide-react'
import { Card } from '@/components/ui/Card'
import { getBackendUrl } from '@/lib/backend-url'

interface StockoutSummary {
  windowDays: number
  eventsInWindow: number
  openCount: number
  totalLostRevenueCents: number
  totalLostMarginCents: number
  totalDurationDays: number | string
  totalLostUnits: number
  worstSku: {
    sku: string
    durationDays: number | string
    estimatedLostMargin: number | null
  } | null
}

export function StockoutImpactCard() {
  const [data, setData] = useState<StockoutSummary | null>(null)
  const [loading, setLoading] = useState(true)
  const [refreshTick, setRefreshTick] = useState(0)

  useEffect(() => {
    setLoading(true)
    fetch(
      `${getBackendUrl()}/api/fulfillment/replenishment/stockouts/summary?windowDays=30`,
      { cache: 'no-store' },
    )
      .then((r) => (r.ok ? r.json() : null))
      .then(setData)
      .catch(() => setData(null))
      .finally(() => setLoading(false))
  }, [refreshTick])

  if (loading || !data) return null
  // Silent on no data — the page already has plenty of content.
  if (data.eventsInWindow === 0 && data.openCount === 0) return null

  const lostRev = data.totalLostRevenueCents / 100
  const lostMargin = data.totalLostMarginCents / 100

  return (
    <Card>
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div>
          <div className="text-sm uppercase tracking-wider text-slate-500 dark:text-slate-400 font-semibold">
            Stockout impact (last {data.windowDays} days)
          </div>
          <div className="mt-1 flex items-baseline gap-3 flex-wrap">
            <span className="text-[20px] font-semibold tabular-nums text-rose-700 dark:text-rose-400">
              {lostMargin.toFixed(0)}€ lost margin
            </span>
            {data.openCount > 0 && (
              <span className="text-sm text-rose-700 dark:text-rose-400 font-semibold">
                {data.openCount} ongoing
              </span>
            )}
          </div>
          <div className="text-sm text-slate-500 dark:text-slate-400 mt-0.5">
            {data.eventsInWindow} event{data.eventsInWindow === 1 ? '' : 's'} ·{' '}
            {Number(data.totalDurationDays).toFixed(1)} days total ·{' '}
            {data.totalLostUnits} units lost · {lostRev.toFixed(0)}€ lost revenue
          </div>
          {data.worstSku && (
            <div className="text-sm text-slate-500 dark:text-slate-400 mt-0.5">
              Worst: <span className="font-mono">{data.worstSku.sku}</span> (
              {Number(data.worstSku.durationDays).toFixed(1)}d
              {data.worstSku.estimatedLostMargin != null
                ? `, ${(data.worstSku.estimatedLostMargin / 100).toFixed(0)}€ lost`
                : ''}
              )
            </div>
          )}
        </div>
        <button
          onClick={() => setRefreshTick((n) => n + 1)}
          className="h-7 px-2 text-sm border border-slate-200 dark:border-slate-700 text-slate-700 dark:text-slate-300 rounded hover:bg-slate-50 dark:hover:bg-slate-800 inline-flex items-center gap-1"
          title="Refresh"
        >
          <RefreshCw size={11} /> Refresh
        </button>
      </div>
    </Card>
  )
}
