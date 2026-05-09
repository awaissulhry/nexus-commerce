'use client'

/**
 * W9.6m — Recommendation history audit card (R.3 origin).
 *
 * Extracted from ReplenishmentWorkspace.tsx. Shows a chronological
 * list of every recommendation we've ever shown for this product,
 * with status pills (ACTIVE / SUPERSEDED / ACTED / DISMISSED) +
 * urgency + qty + the resulting PO/WO when ACTED. Lazy-loaded on
 * expand so closed drawers don't fire the request.
 *
 * R.5 polish included: status filter chips with per-status counts,
 * show-all/show-less toggle (default 5 rows visible, fetches 50).
 *
 * Adds dark-mode classes throughout (header, filter chips, list
 * rows, status pills, all four status tones).
 */

import { useEffect, useState } from 'react'
import { cn } from '@/lib/utils'
import { getBackendUrl } from '@/lib/backend-url'

interface HistoryRow {
  id: string
  status: string
  urgency: string
  reorderQuantity: number
  effectiveStock: number
  generatedAt: string
  actedAt: string | null
  resultingPoId: string | null
  resultingWorkOrderId: string | null
  overrideQuantity: number | null
}

interface HistoryResponse {
  history: HistoryRow[]
}

const HISTORY_FILTERS = [
  { key: 'all', label: 'All' },
  { key: 'ACTIVE', label: 'Active' },
  { key: 'ACTED', label: 'Acted' },
  { key: 'DISMISSED', label: 'Dismissed' },
  { key: 'SUPERSEDED', label: 'Super.' },
]

export function RecommendationHistoryCard({
  productId,
}: {
  productId: string | null
}) {
  const [open, setOpen] = useState(false)
  const [data, setData] = useState<HistoryResponse | null>(null)
  const [loading, setLoading] = useState(false)
  const [showAll, setShowAll] = useState(false)
  const [statusFilter, setStatusFilter] = useState<string>('all')

  useEffect(() => {
    if (!open || !productId || data) return
    setLoading(true)
    fetch(
      `${getBackendUrl()}/api/fulfillment/replenishment/${productId}/history?limit=50`,
      { cache: 'no-store' },
    )
      .then((r) => (r.ok ? r.json() : null))
      .then(setData)
      .catch(() => setData(null))
      .finally(() => setLoading(false))
  }, [open, productId, data])

  if (!productId) return null

  const allHistory = data?.history ?? []
  const counts: Record<string, number> = { all: allHistory.length }
  for (const h of allHistory) counts[h.status] = (counts[h.status] ?? 0) + 1
  const filtered =
    statusFilter === 'all'
      ? allHistory
      : allHistory.filter((h) => h.status === statusFilter)
  const visible = showAll ? filtered : filtered.slice(0, 5)
  const hidden = filtered.length - visible.length

  return (
    <div>
      <button
        onClick={() => setOpen((v) => !v)}
        className="text-sm uppercase tracking-wider text-slate-500 dark:text-slate-400 font-semibold inline-flex items-center gap-1 hover:text-slate-700 dark:hover:text-slate-200"
      >
        History {open ? '▾' : '▸'}
        {data?.history && (
          <span className="text-slate-400 dark:text-slate-500 normal-case font-normal">
            ({data.history.length})
          </span>
        )}
      </button>
      {open && (
        <div className="mt-2">
          {loading && (
            <div className="text-base text-slate-400 dark:text-slate-500">
              Loading…
            </div>
          )}
          {!loading && allHistory.length === 0 && (
            <div className="text-sm text-slate-500 dark:text-slate-400 italic">
              No history yet — recommendations are persisted starting from this
              commit.
            </div>
          )}
          {!loading && allHistory.length > 0 && (
            <>
              {/* Status filter chips — R.5 polish */}
              {allHistory.length > 1 && (
                <div className="flex items-center gap-1 mb-2 flex-wrap">
                  {HISTORY_FILTERS.map((f) => {
                    const c = counts[f.key] ?? 0
                    if (f.key !== 'all' && c === 0) return null
                    return (
                      <button
                        key={f.key}
                        type="button"
                        onClick={() => {
                          setStatusFilter(f.key)
                          setShowAll(false)
                        }}
                        className={cn(
                          'px-2 py-0.5 text-xs font-medium rounded border transition-colors',
                          statusFilter === f.key
                            ? 'bg-slate-900 dark:bg-slate-700 text-white border-slate-900 dark:border-slate-700'
                            : 'bg-white dark:bg-slate-900 text-slate-600 dark:text-slate-400 border-slate-200 dark:border-slate-700 hover:border-slate-300 dark:hover:border-slate-600',
                        )}
                      >
                        {f.label}
                        <span className="ml-1 opacity-70">{c}</span>
                      </button>
                    )
                  })}
                </div>
              )}
              <ul className="space-y-1 text-sm">
                {visible.map((h) => {
                  const tone =
                    h.status === 'ACTIVE'
                      ? 'bg-blue-50 border-blue-200 text-blue-700 dark:bg-blue-950/40 dark:border-blue-900 dark:text-blue-300'
                      : h.status === 'ACTED'
                        ? 'bg-emerald-50 border-emerald-200 text-emerald-700 dark:bg-emerald-950/40 dark:border-emerald-900 dark:text-emerald-300'
                        : h.status === 'DISMISSED'
                          ? 'bg-slate-100 border-slate-200 text-slate-500 dark:bg-slate-800 dark:border-slate-700 dark:text-slate-400'
                          : 'bg-slate-50 border-slate-200 text-slate-600 dark:bg-slate-900 dark:border-slate-800 dark:text-slate-400'
                  return (
                    <li
                      key={h.id}
                      className="flex items-start gap-2 border border-slate-100 dark:border-slate-800 rounded px-2 py-1"
                    >
                      <span className="text-slate-500 dark:text-slate-400 tabular-nums w-28 flex-shrink-0">
                        {new Date(h.generatedAt)
                          .toISOString()
                          .slice(0, 16)
                          .replace('T', ' ')}
                      </span>
                      <span
                        className={cn(
                          'text-xs uppercase tracking-wider px-1.5 py-0.5 rounded border w-20 text-center flex-shrink-0',
                          tone,
                        )}
                      >
                        {h.status === 'SUPERSEDED' ? 'SUPER.' : h.status}
                      </span>
                      <span className="text-slate-700 dark:text-slate-300 flex-shrink-0">
                        {h.urgency}
                      </span>
                      <span className="text-slate-600 dark:text-slate-400 tabular-nums flex-shrink-0">
                        qty {h.reorderQuantity}
                      </span>
                      <span className="text-slate-500 dark:text-slate-500 tabular-nums flex-shrink-0">
                        stock {h.effectiveStock}
                      </span>
                      {h.actedAt &&
                        (h.resultingPoId || h.resultingWorkOrderId) && (
                          <span className="text-emerald-700 dark:text-emerald-400 truncate">
                            → {h.resultingPoId ? 'PO ' : 'WO '}
                            {(
                              h.resultingPoId ?? h.resultingWorkOrderId
                            )!.slice(-8)}
                            {h.overrideQuantity != null &&
                              h.overrideQuantity !== h.reorderQuantity && (
                                <span className="text-slate-500 dark:text-slate-400">
                                  {' '}
                                  (override {h.reorderQuantity}→
                                  {h.overrideQuantity})
                                </span>
                              )}
                          </span>
                        )}
                    </li>
                  )
                })}
              </ul>
              {hidden > 0 && (
                <button
                  type="button"
                  onClick={() => setShowAll(true)}
                  className="mt-2 text-sm text-blue-700 dark:text-blue-400 hover:text-blue-900 dark:hover:text-blue-300 font-medium"
                >
                  Show all {filtered.length}
                </button>
              )}
              {showAll && filtered.length > 5 && (
                <button
                  type="button"
                  onClick={() => setShowAll(false)}
                  className="mt-2 text-sm text-slate-500 dark:text-slate-400 hover:text-slate-700 dark:hover:text-slate-200 font-medium"
                >
                  Show less
                </button>
              )}
              {filtered.length === 0 && statusFilter !== 'all' && (
                <div className="text-sm text-slate-500 dark:text-slate-400 italic">
                  No {statusFilter.toLowerCase()} entries.
                </div>
              )}
            </>
          )}
        </div>
      )}
    </div>
  )
}
