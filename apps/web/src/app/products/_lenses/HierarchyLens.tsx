'use client'

/**
 * P.1a — extracted from ProductsWorkspace.tsx as part of the
 * file-decomposition sweep. Self-contained: takes `search` as the
 * only prop, fetches its own data via /api/pim/parents-overview +
 * /api/pim/standalones.
 *
 * Two cards side-by-side on lg: parents (products with at least
 * one child variation) and standalones (products that aren't parents
 * — could be promoted, attached, or kept standalone). Each card
 * caps at 50 items; if you need more, the operator drills via
 * /catalog/organize.
 */

import { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import { ChevronDown, FolderTree, Package } from 'lucide-react'
import { Card } from '@/components/ui/Card'
import { getBackendUrl } from '@/lib/backend-url'

interface PimItem {
  id: string
  sku: string
  name: string
  childCount?: number
}

export function HierarchyLens({ search }: { search: string }) {
  const [parents, setParents] = useState<PimItem[]>([])
  const [standalones, setStandalones] = useState<PimItem[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const [p, s] = await Promise.all([
        fetch(
          `${getBackendUrl()}/api/pim/parents-overview?search=${encodeURIComponent(search)}&limit=100`,
        ).then(async (r) => {
          if (!r.ok) throw new Error(`parents HTTP ${r.status}`)
          return r.json()
        }),
        fetch(
          `${getBackendUrl()}/api/pim/standalones?search=${encodeURIComponent(search)}&limit=100`,
        ).then(async (r) => {
          if (!r.ok) throw new Error(`standalones HTTP ${r.status}`)
          return r.json()
        }),
      ])
      setParents(p.items ?? [])
      setStandalones(s.items ?? [])
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }, [search])

  useEffect(() => {
    void refresh()
  }, [refresh])

  if (loading)
    return (
      <Card>
        <div
          role="status"
          aria-live="polite"
          className="text-md text-slate-500 dark:text-slate-400 py-8 text-center"
        >
          Loading hierarchy…
        </div>
      </Card>
    )
  if (error)
    return (
      <Card>
        <div role="alert" className="py-8 text-center space-y-2">
          <div className="text-md text-rose-600 dark:text-rose-400">
            Failed to load hierarchy: {error}
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

  return (
    <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
      <Card
        title={`Parents (${parents.length})`}
        description="Products with at least one child variation"
      >
        {parents.length === 0 ? (
          <div className="py-8 text-center text-base text-slate-500 dark:text-slate-400">
            <FolderTree className="w-6 h-6 mx-auto text-slate-300 dark:text-slate-600 mb-2" />
            No parent products yet.
            <div className="text-sm text-slate-400 dark:text-slate-500 mt-1">
              Use{' '}
              <Link href="/catalog/organize" className="text-blue-700 hover:underline dark:text-blue-300">
                Organize → Parents
              </Link>
              {' '}to group SKUs that share variant attributes.
            </div>
          </div>
        ) : (
          <ul className="space-y-1 -my-1">
            {parents.slice(0, 50).map((p) => (
              <li key={p.id}>
                <Link
                  href={`/products/${p.id}/edit?tab=variations`}
                  className="flex items-center justify-between gap-3 py-1.5 px-2 -mx-2 rounded hover:bg-slate-50 dark:hover:bg-slate-800"
                >
                  <div className="min-w-0 flex-1">
                    <div className="text-md text-slate-900 dark:text-slate-100 truncate">
                      {p.name}
                    </div>
                    <div className="text-sm text-slate-500 dark:text-slate-400 font-mono">
                      {p.sku} · {p.childCount ?? 0} children
                    </div>
                  </div>
                  <ChevronDown
                    size={14}
                    className="text-slate-400 dark:text-slate-500 -rotate-90"
                  />
                </Link>
              </li>
            ))}
          </ul>
        )}
      </Card>
      <Card
        title={`Standalones (${standalones.length})`}
        description="Products that aren't parents (could be promoted, attached, or kept standalone)"
      >
        {standalones.length === 0 ? (
          <div className="py-8 text-center text-base text-slate-500 dark:text-slate-400">
            <Package className="w-6 h-6 mx-auto text-slate-300 dark:text-slate-600 mb-2" />
            All products belong to a parent.
            <div className="text-sm text-slate-400 dark:text-slate-500 mt-1">
              Standalone products will appear here as you create new SKUs.
            </div>
          </div>
        ) : (
          <ul className="space-y-1 -my-1">
            {standalones.slice(0, 50).map((p) => (
              <li
                key={p.id}
                className="flex items-center justify-between gap-3 py-1.5 px-2 -mx-2 rounded hover:bg-slate-50 dark:hover:bg-slate-800"
              >
                <div className="min-w-0 flex-1">
                  <div className="text-md text-slate-900 dark:text-slate-100 truncate">
                    {p.name}
                  </div>
                  <div className="text-sm text-slate-500 dark:text-slate-400 font-mono">
                    {p.sku}
                  </div>
                </div>
                <Link
                  href="/catalog/organize"
                  className="text-sm text-blue-600 hover:underline dark:text-blue-400"
                >
                  Group →
                </Link>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  )
}
