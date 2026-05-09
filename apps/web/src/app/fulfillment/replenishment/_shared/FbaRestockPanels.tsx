'use client'

/**
 * W9.6k — FBA Restock cards (R.8 origin).
 *
 * Two pieces, one file:
 *   FbaRestockHealthCard     workspace-level — per-marketplace
 *                            ingestion health with manual refresh.
 *                            Silent until first successful ingest.
 *   FbaRestockSignalPanel    drawer-level — Amazon's recommended qty
 *                            vs ours, with divergence advisory.
 *
 * Both extracted from ReplenishmentWorkspace.tsx. Adds dark-mode
 * classes throughout the chrome (per-marketplace tiles, refresh
 * button, divergence tints, advisory text).
 */

import { useEffect, useState } from 'react'
import { Card } from '@/components/ui/Card'
import { cn } from '@/lib/utils'
import { getBackendUrl } from '@/lib/backend-url'
import type { DetailResponse } from './types'

interface FbaRestockHealth {
  items: Array<{
    marketplaceCode: string
    marketplaceId: string
    lastIngestedAt: string | null
    rowCount: number
    hasFreshData: boolean
  }>
  staleDays: number
  cron: { scheduled: boolean; lastRunAt: string | null }
}

export function FbaRestockHealthCard() {
  const [data, setData] = useState<FbaRestockHealth | null>(null)
  const [refreshing, setRefreshing] = useState(false)

  async function load() {
    try {
      const res = await fetch(
        `${getBackendUrl()}/api/fulfillment/replenishment/fba-restock/status`,
        { cache: 'no-store' },
      )
      if (res.ok) setData(await res.json())
    } catch {
      // silent
    }
  }
  useEffect(() => {
    void load()
  }, [])

  async function manualRefresh() {
    setRefreshing(true)
    try {
      await fetch(
        `${getBackendUrl()}/api/fulfillment/replenishment/fba-restock/refresh`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({}),
        },
      )
      await load()
    } finally {
      setRefreshing(false)
    }
  }

  if (!data) return null
  const anyFresh = data.items.some((i) => i.hasFreshData)
  if (!anyFresh && !data.cron?.scheduled) return null

  function fmtAge(iso: string | null) {
    if (!iso) return '—'
    const ms = Date.now() - new Date(iso).getTime()
    const h = Math.floor(ms / 3600000)
    if (h < 1) return 'just now'
    if (h < 24) return `${h}h ago`
    return `${Math.floor(h / 24)}d ago`
  }

  return (
    <Card className="p-4 mb-3">
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-2">
          <span className="text-sm uppercase tracking-wider text-slate-500 dark:text-slate-400 font-semibold">
            Amazon Restock signal
          </span>
          <span className="text-xs text-slate-400 dark:text-slate-500">
            staleness cutoff {data.staleDays}d
          </span>
        </div>
        <button
          type="button"
          onClick={() => void manualRefresh()}
          disabled={refreshing}
          className="text-sm text-indigo-600 dark:text-indigo-400 hover:underline disabled:opacity-50"
        >
          {refreshing ? 'refreshing…' : 'refresh now'}
        </button>
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-3 lg:grid-cols-5 gap-2">
        {data.items.map((it) => (
          <div
            key={it.marketplaceCode}
            className={cn(
              'border rounded p-2 text-sm',
              it.hasFreshData
                ? 'border-slate-200 dark:border-slate-800 bg-slate-50/50 dark:bg-slate-950/40'
                : 'border-amber-200 dark:border-amber-900 bg-amber-50/40 dark:bg-amber-950/30',
            )}
          >
            <div className="flex items-center justify-between mb-0.5">
              <span className="font-mono font-semibold text-slate-900 dark:text-slate-100">
                {it.marketplaceCode}
              </span>
              <span
                className={cn(
                  'text-xs',
                  it.hasFreshData
                    ? 'text-emerald-700 dark:text-emerald-400'
                    : 'text-amber-700 dark:text-amber-400',
                )}
              >
                {it.hasFreshData ? 'fresh' : 'stale'}
              </span>
            </div>
            <div className="text-slate-500 dark:text-slate-400">
              {fmtAge(it.lastIngestedAt)}
            </div>
            <div className="font-mono text-slate-700 dark:text-slate-300">
              {it.rowCount.toLocaleString()} rows
            </div>
          </div>
        ))}
      </div>
    </Card>
  )
}

// R.8 — drawer: Amazon recommendation vs ours. Rendered only when
// the rec carries a fresh amazonRecommendedQty (set by the engine
// on FBA-fulfilled SKUs). Surfaces divergence so the operator can
// reconcile before pushing a PO.
export function FbaRestockSignalPanel({
  rec,
}: {
  rec: NonNullable<DetailResponse['recommendation']>
}) {
  if (rec.amazonRecommendedQty == null) return null
  const ours = rec.reorderQuantity
  const amazon = rec.amazonRecommendedQty
  const delta = rec.amazonDeltaPct == null ? null : Number(rec.amazonDeltaPct)
  const isAligned = delta != null && Math.abs(delta) < 20
  const amazonHigher = delta != null && delta >= 20
  const ourHigher = delta != null && delta <= -20
  const tint = isAligned
    ? 'border-emerald-200 dark:border-emerald-900 bg-emerald-50/40 dark:bg-emerald-950/30'
    : 'border-amber-200 dark:border-amber-900 bg-amber-50/40 dark:bg-amber-950/30'
  const label = isAligned
    ? 'Aligned with Amazon'
    : amazonHigher
      ? 'Amazon recommends more'
      : ourHigher
        ? 'We recommend more'
        : 'Cross-check'
  const ageLabel = rec.amazonReportAsOf
    ? `${Math.max(0, Math.floor((Date.now() - new Date(rec.amazonReportAsOf).getTime()) / 86400000))}d old`
    : 'fresh'
  return (
    <div className={cn('border rounded p-3', tint)}>
      <div className="flex items-center justify-between mb-2">
        <span className="text-sm uppercase tracking-wider text-slate-500 dark:text-slate-400 font-semibold">
          {label}
        </span>
        <span className="text-xs text-slate-400 dark:text-slate-500">
          Amazon Restock · {ageLabel}
        </span>
      </div>
      <div className="grid grid-cols-3 gap-2 text-base">
        <div>
          <div className="text-slate-500 dark:text-slate-400">Ours</div>
          <div className="font-mono font-semibold text-slate-900 dark:text-slate-100">
            {ours}u
          </div>
        </div>
        <div>
          <div className="text-slate-500 dark:text-slate-400">Amazon</div>
          <div className="font-mono font-semibold text-slate-900 dark:text-slate-100">
            {amazon}u
          </div>
        </div>
        <div>
          <div className="text-slate-500 dark:text-slate-400">Δ</div>
          <div
            className={cn(
              'font-mono font-semibold',
              amazonHigher
                ? 'text-amber-700 dark:text-amber-400'
                : ourHigher
                  ? 'text-sky-700 dark:text-sky-400'
                  : 'text-slate-700 dark:text-slate-300',
            )}
          >
            {delta != null ? `${delta > 0 ? '+' : ''}${delta.toFixed(1)}%` : '—'}
          </div>
        </div>
      </div>
      {!isAligned && (
        <p className="mt-2 text-xs text-slate-600 dark:text-slate-400 leading-snug">
          {amazonHigher &&
            'Amazon sees demand we may not — check for a regional spike or post-event lift on this SKU. '}
          {ourHigher &&
            'Our blended view suggests more inventory than Amazon alone — likely non-Amazon channel demand. '}
          Advisory only; the engine has not changed the recommended qty.
        </p>
      )}
    </div>
  )
}
