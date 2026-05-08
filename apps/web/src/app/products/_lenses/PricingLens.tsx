'use client'

/**
 * P.1e — extracted from ProductsWorkspace.tsx as part of the
 * file-decomposition sweep. Originally P.5.
 *
 * Reads PricingSnapshot rows from /api/pricing/matrix, indexes by
 * (sku, marketplace), and renders the in-scope products as rows
 * with one cell per top marketplace. Each cell shows the resolved
 * price + currency code; tone signals issues:
 *
 *   amber  isClamped (price was hit a floor/ceiling rule)
 *   rose   warnings non-empty (cost > price, etc.)
 *   slate  no snapshot (rule didn't compute or hasn't run yet)
 *   text   normal
 *
 * Click a cell → /pricing?search=<sku> for the full-fat matrix
 * with explain / push / per-cell drawer. This lens is the
 * birds-eye scan; the dedicated /pricing page is where you act.
 *
 * Marketplaces are fixed to the canonical Xavia set (IT, DE, UK,
 * FR, ES). Adding a marketplace later is a one-line change here.
 */

import { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import { Loader2, DollarSign, ChevronRight } from 'lucide-react'
import { Card } from '@/components/ui/Card'
import { EmptyState } from '@/components/ui/EmptyState'
import { getBackendUrl } from '@/lib/backend-url'
import { useInvalidationChannel } from '@/lib/sync/invalidation-channel'

interface PricingProduct {
  id: string
  sku: string
  name: string
}

interface SnapshotCell {
  price: string
  currency: string
  isClamped: boolean
  warnings: string[]
}

export function PricingLens({
  products,
  loading,
}: {
  products: PricingProduct[]
  loading: boolean
}) {
  const MARKETPLACES = ['IT', 'DE', 'UK', 'FR', 'ES'] as const
  const [snapshots, setSnapshots] = useState<
    Record<string, Record<string, SnapshotCell>>
  >({})
  const [snapLoading, setSnapLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    setSnapLoading(true)
    setError(null)
    try {
      // Fetch one big page of recent snapshots scoped to the
      // marketplaces we're rendering. Server-side filter on
      // marketplace would require list-of-values support; for now
      // we pull a wider set (limit=500) and filter client-side. At
      // 5 marketplaces × ~3,200 SKUs = ~16k snapshots max in
      // theory; in practice the snapshot table is much smaller.
      const res = await fetch(
        `${getBackendUrl()}/api/pricing/matrix?limit=500`,
        { cache: 'no-store' },
      )
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const json = await res.json()
      const indexed: Record<string, Record<string, SnapshotCell>> = {}
      for (const r of (json.rows ?? []) as Array<{
        sku: string
        marketplace: string
        computedPrice: string
        currency: string
        isClamped: boolean
        warnings: string[]
      }>) {
        if (!indexed[r.sku]) indexed[r.sku] = {}
        indexed[r.sku][r.marketplace] = {
          price: r.computedPrice,
          currency: r.currency,
          isClamped: r.isClamped,
          warnings: r.warnings ?? [],
        }
      }
      setSnapshots(indexed)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setSnapLoading(false)
    }
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  // Refresh when prices change in any tab — bulk-price-override,
  // inline edit on /products, or a per-row push from /pricing all
  // emit product.updated; we re-pull the snapshots so the lens
  // reflects current state.
  useInvalidationChannel(
    ['product.updated', 'bulk-job.completed'],
    () => {
      void refresh()
    },
  )

  if (loading || snapLoading) {
    return (
      <Card>
        <div
          role="status"
          aria-live="polite"
          className="text-md text-slate-500 dark:text-slate-400 py-8 text-center inline-flex items-center justify-center gap-2 w-full"
        >
          <Loader2 className="w-3.5 h-3.5 animate-spin" /> Loading pricing
          matrix…
        </div>
      </Card>
    )
  }
  if (error) {
    return (
      <Card>
        <div role="alert" className="py-8 text-center space-y-2">
          <div className="text-md text-rose-600 dark:text-rose-400">
            Failed to load pricing matrix: {error}
          </div>
          <button
            type="button"
            onClick={() => void refresh()}
            className="h-7 px-3 text-sm bg-slate-900 text-white rounded hover:bg-slate-800 dark:bg-slate-100 dark:text-slate-900 dark:hover:bg-slate-200 inline-flex items-center gap-1.5"
          >
            Retry
          </button>
        </div>
      </Card>
    )
  }
  if (products.length === 0) {
    return (
      <EmptyState
        icon={DollarSign}
        title="No products to price"
        description="The Pricing matrix shows base price + per-channel overrides + min/max clamps. Match at least one product with your filter to see the matrix."
        action={{ label: 'Clear filters', href: '/products' }}
      />
    )
  }

  // Summary header — count of cells with each tone, so the
  // operator scanning the lens sees "12 clamped, 3 warnings"
  // before reading the table.
  let cellCount = 0
  let clampedCount = 0
  let warningCount = 0
  let missingCount = 0
  for (const p of products.slice(0, 100)) {
    for (const mp of MARKETPLACES) {
      cellCount++
      const cell = snapshots[p.sku]?.[mp]
      if (!cell) missingCount++
      else if (cell.warnings.length > 0) warningCount++
      else if (cell.isClamped) clampedCount++
    }
  }

  return (
    <div className="space-y-3">
      <Card>
        <div className="flex items-center gap-4 text-base">
          <span className="text-slate-700 dark:text-slate-300">
            <span className="font-semibold tabular-nums">{cellCount}</span>{' '}
            cells
          </span>
          {clampedCount > 0 && (
            <span className="text-amber-700 dark:text-amber-300 inline-flex items-center gap-1">
              <span className="inline-block w-2 h-2 bg-amber-500 rounded-full" />
              <span className="tabular-nums">{clampedCount}</span> clamped
            </span>
          )}
          {warningCount > 0 && (
            <span className="text-rose-700 dark:text-rose-300 inline-flex items-center gap-1">
              <span className="inline-block w-2 h-2 bg-rose-500 rounded-full" />
              <span className="tabular-nums">{warningCount}</span> with warnings
            </span>
          )}
          {missingCount > 0 && (
            <span className="text-slate-500 dark:text-slate-400 inline-flex items-center gap-1">
              <span className="inline-block w-2 h-2 bg-slate-300 dark:bg-slate-600 rounded-full" />
              <span className="tabular-nums">{missingCount}</span> missing
              snapshots
            </span>
          )}
          <Link
            href="/pricing"
            className="ml-auto text-base text-blue-700 hover:underline dark:text-blue-300 inline-flex items-center gap-1"
          >
            Open full pricing matrix <ChevronRight size={12} />
          </Link>
        </div>
      </Card>
      <Card noPadding>
        <div className="overflow-x-auto">
          <table className="w-full text-base">
            <thead className="bg-slate-50 border-b border-slate-200 dark:bg-slate-800 dark:border-slate-800">
              <tr>
                <th className="px-3 py-2 text-left text-sm font-semibold uppercase text-slate-700 sticky left-0 bg-slate-50 z-10 min-w-[260px] dark:text-slate-300 dark:bg-slate-800">
                  Product
                </th>
                {MARKETPLACES.map((mp) => (
                  <th
                    key={mp}
                    className="px-3 py-2 text-center text-xs font-semibold uppercase text-slate-500 dark:text-slate-400"
                  >
                    {mp}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {products.slice(0, 100).map((p) => (
                <tr
                  key={p.id}
                  className="border-b border-slate-100 hover:bg-slate-50/50 dark:border-slate-800 dark:hover:bg-slate-800/50"
                >
                  <td className="px-3 py-2 sticky left-0 bg-white border-r border-slate-100 dark:bg-slate-900 dark:border-slate-800">
                    <Link
                      href={`/products/${p.id}/edit`}
                      className="block hover:text-blue-600 dark:hover:text-blue-400"
                    >
                      <div className="text-md font-medium text-slate-900 dark:text-slate-100 truncate max-w-xs">
                        {p.name}
                      </div>
                      <div className="text-sm text-slate-500 dark:text-slate-400 font-mono">
                        {p.sku}
                      </div>
                    </Link>
                  </td>
                  {MARKETPLACES.map((mp) => {
                    const cell = snapshots[p.sku]?.[mp]
                    if (!cell) {
                      return (
                        <td
                          key={mp}
                          className="px-2 py-2 text-center text-slate-300 dark:text-slate-600 text-sm"
                          title="No pricing snapshot — rule may not have run yet"
                        >
                          —
                        </td>
                      )
                    }
                    const tone =
                      cell.warnings.length > 0
                        ? 'bg-rose-50 text-rose-700 border-rose-200 dark:bg-rose-950/40 dark:text-rose-300 dark:border-rose-800'
                        : cell.isClamped
                          ? 'bg-amber-50 text-amber-700 border-amber-200 dark:bg-amber-950/40 dark:text-amber-300 dark:border-amber-800'
                          : 'bg-white text-slate-900 border-slate-200 dark:bg-slate-900 dark:text-slate-100 dark:border-slate-800'
                    const titleParts: string[] = []
                    if (cell.isClamped)
                      titleParts.push('clamped to floor/ceiling')
                    if (cell.warnings.length > 0)
                      titleParts.push(...cell.warnings)
                    return (
                      <td key={mp} className="px-2 py-2 text-center">
                        <Link
                          href={`/pricing?search=${encodeURIComponent(p.sku)}&marketplace=${mp}`}
                          title={titleParts.join(' · ') || 'Open in pricing matrix'}
                          className={`inline-flex items-center px-2 py-1 border rounded text-sm tabular-nums hover:opacity-80 ${tone}`}
                        >
                          {Number(cell.price).toFixed(2)} {cell.currency}
                        </Link>
                      </td>
                    )
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
      {products.length > 100 && (
        <div className="text-sm text-slate-500 dark:text-slate-400 text-center">
          Showing first 100 products. Open the full pricing matrix or narrow
          filters to see more.
        </div>
      )}
    </div>
  )
}
