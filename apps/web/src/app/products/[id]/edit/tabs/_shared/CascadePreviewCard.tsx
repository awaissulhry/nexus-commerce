'use client'

/**
 * PIM E.4 — Cascade preview card.
 *
 * Mounts on the Global tab to surface the fan-out of master changes:
 * how many channel listings × marketplaces × variants will be touched
 * if the operator edits a master field on this product.
 *
 * Per-tracked-field totals (title, description, price, quantity,
 * bulletPoints) show inherit count vs override count so operators
 * immediately see "if I change price, 7 listings update and 3 are
 * pinned with overrides." Click a field row to expand the
 * per-marketplace breakdown.
 */

import { useEffect, useState, useCallback } from 'react'
import {
  GitBranch,
  Loader2,
  AlertCircle,
  ChevronRight,
  ChevronDown,
  Layers,
  RefreshCw,
} from 'lucide-react'
import { getBackendUrl } from '@/lib/backend-url'
import { cn } from '@/lib/utils'

interface CascadeCell {
  channel: string
  marketplace: string
  total: number
  inheritByField: Record<string, number>
  overrideByField: Record<string, number>
}

interface CascadePreview {
  productId: string
  productSku: string
  isVariant: boolean
  variantCount: number
  totalListings: number
  marketplaceCount: number
  cells: CascadeCell[]
  totals: Record<string, { inherit: number; override: number }>
}

const TRACKED_FIELDS = ['title', 'description', 'price', 'quantity', 'bulletPoints'] as const

interface Props {
  productId: string
  /** Bumped by parent after a save → forces a refetch so the inherit/
   *  override counts stay current. */
  refreshKey?: number
  className?: string
}

export default function CascadePreviewCard({ productId, refreshKey = 0, className }: Props) {
  const [view, setView] = useState<CascadePreview | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [expandedField, setExpandedField] = useState<string | null>(null)

  const fetchPreview = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const r = await fetch(
        `${getBackendUrl()}/api/products/${productId}/cascade-preview`,
        { cache: 'no-store' },
      )
      if (!r.ok) throw new Error(`HTTP ${r.status}`)
      const data = (await r.json()) as CascadePreview
      setView(data)
    } catch (e: any) {
      setError(e?.message ?? 'Failed to load')
    } finally {
      setLoading(false)
    }
  }, [productId])

  useEffect(() => {
    void fetchPreview()
  }, [fetchPreview, refreshKey])

  if (loading) {
    return (
      <div
        className={cn(
          'rounded-lg border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-950 p-4',
          className,
        )}
      >
        <div className="flex items-center gap-2 text-sm text-zinc-500">
          <Loader2 className="w-3.5 h-3.5 animate-spin" />
          Loading cascade preview…
        </div>
      </div>
    )
  }
  if (error || !view) {
    return (
      <div
        className={cn(
          'rounded-lg border border-red-200 dark:border-red-900 bg-red-50/40 dark:bg-red-900/10 p-4',
          className,
        )}
      >
        <div className="flex items-center gap-2 text-sm text-red-700 dark:text-red-300">
          <AlertCircle className="w-4 h-4" />
          {error ?? 'Failed to load'}
        </div>
      </div>
    )
  }

  if (view.totalListings === 0 && view.variantCount === 0) {
    return (
      <div
        className={cn(
          'rounded-lg border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-950 p-4',
          className,
        )}
      >
        <div className="flex items-center gap-2 text-xs text-zinc-500">
          <GitBranch className="w-3.5 h-3.5 text-zinc-400" />
          No downstream listings or variants yet — master changes won't cascade until this product
          is published to a channel.
        </div>
      </div>
    )
  }

  return (
    <div
      className={cn(
        'rounded-lg border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-950',
        className,
      )}
    >
      <header className="px-4 py-2.5 border-b border-zinc-100 dark:border-zinc-800 flex items-center justify-between">
        <div>
          <h3 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100 flex items-center gap-1.5">
            <GitBranch className="w-3.5 h-3.5 text-zinc-400" />
            Cascade preview
          </h3>
          <p className="text-[11px] text-zinc-500 mt-0.5">
            Master changes fan out to{' '}
            <span className="font-medium text-zinc-700 dark:text-zinc-300">
              {view.totalListings}
            </span>{' '}
            listings across{' '}
            <span className="font-medium text-zinc-700 dark:text-zinc-300">
              {view.marketplaceCount}
            </span>{' '}
            marketplaces
            {view.variantCount > 0 && (
              <>
                {' '}+{' '}
                <span className="font-medium text-zinc-700 dark:text-zinc-300">
                  {view.variantCount}
                </span>{' '}
                <span className="inline-flex items-baseline gap-0.5">
                  <Layers className="w-2.5 h-2.5 self-center" />
                  variants
                </span>
              </>
            )}
            .
          </p>
        </div>
        <button
          type="button"
          onClick={() => void fetchPreview()}
          className="text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200"
          title="Refresh"
        >
          <RefreshCw className="w-3 h-3" />
        </button>
      </header>

      <div className="px-3 py-2">
        <ol className="divide-y divide-zinc-100 dark:divide-zinc-800">
          {TRACKED_FIELDS.map((f) => {
            const total = view.totals[f]
            const isExpanded = expandedField === f
            const inheritCount = total?.inherit ?? 0
            const overrideCount = total?.override ?? 0
            return (
              <li key={f}>
                <button
                  type="button"
                  onClick={() => setExpandedField(isExpanded ? null : f)}
                  className="w-full flex items-center justify-between px-2 py-1.5 hover:bg-zinc-50 dark:hover:bg-zinc-900/50 rounded"
                >
                  <div className="flex items-center gap-1.5 min-w-0">
                    {isExpanded ? (
                      <ChevronDown className="w-3 h-3 text-zinc-400" />
                    ) : (
                      <ChevronRight className="w-3 h-3 text-zinc-400" />
                    )}
                    <span className="text-xs font-mono text-zinc-700 dark:text-zinc-300">
                      {f}
                    </span>
                  </div>
                  <div className="flex items-center gap-2 text-[11px]">
                    <span className="text-emerald-700 dark:text-emerald-400">
                      {inheritCount} inherit
                    </span>
                    {overrideCount > 0 && (
                      <span className="text-amber-700 dark:text-amber-400">
                        {overrideCount} override
                      </span>
                    )}
                  </div>
                </button>
                {isExpanded && (
                  <div className="pl-7 pb-2 pr-2">
                    {view.cells.length === 0 ? (
                      <div className="text-[11px] text-zinc-400 italic px-1">
                        No listings published yet.
                      </div>
                    ) : (
                      <ul className="space-y-0.5">
                        {view.cells.map((c) => (
                          <li
                            key={`${c.channel}::${c.marketplace}`}
                            className="flex items-center justify-between text-[11px] text-zinc-600 dark:text-zinc-400 px-1.5 py-0.5 rounded hover:bg-zinc-50 dark:hover:bg-zinc-900/40"
                          >
                            <span>
                              {c.channel} <span className="font-mono">{c.marketplace}</span>
                            </span>
                            <span className="flex items-center gap-1.5">
                              {c.inheritByField[f] > 0 && (
                                <span className="text-emerald-600">
                                  {c.inheritByField[f]} inherit
                                </span>
                              )}
                              {c.overrideByField[f] > 0 && (
                                <span className="text-amber-600">
                                  {c.overrideByField[f]} override
                                </span>
                              )}
                            </span>
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                )}
              </li>
            )
          })}
        </ol>
      </div>
    </div>
  )
}
