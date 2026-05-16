'use client'

import { useMemo, useState } from 'react'
import Link from 'next/link'
import { CATEGORY_LABEL } from '../_shared/ReviewsNav'

interface ProductBucket {
  productId: string
  product: { id: string; sku: string; name: string; productType: string | null } | null
  marketplaces: string[]
  total: number
  positive: number
  neutral: number
  negative: number
  negativePct: number
  topCategories: { category: string; count: number }[]
  lastReviewAt: string | null
}

type SortKey = 'negativePct' | 'total' | 'lastReview' | 'sku'

export function ByProductClient({ initial }: { initial: ProductBucket[] }) {
  const [sortKey, setSortKey] = useState<SortKey>('negativePct')
  const [marketplaceFilter, setMarketplaceFilter] = useState<string>('')

  const marketplaces = useMemo(
    () => Array.from(new Set(initial.flatMap((b) => b.marketplaces))).sort(),
    [initial],
  )

  const items = useMemo(() => {
    let list = initial
    if (marketplaceFilter) {
      list = list.filter((b) => b.marketplaces.includes(marketplaceFilter))
    }
    return [...list].sort((a, b) => {
      switch (sortKey) {
        case 'total':
          return b.total - a.total
        case 'lastReview': {
          if (!a.lastReviewAt && !b.lastReviewAt) return 0
          if (!a.lastReviewAt) return 1
          if (!b.lastReviewAt) return -1
          return new Date(b.lastReviewAt).getTime() - new Date(a.lastReviewAt).getTime()
        }
        case 'sku':
          return (a.product?.sku ?? '').localeCompare(b.product?.sku ?? '')
        case 'negativePct':
        default:
          if (b.negativePct === a.negativePct) return b.total - a.total
          return b.negativePct - a.negativePct
      }
    })
  }, [initial, sortKey, marketplaceFilter])

  return (
    <div>
      <div className="flex items-center gap-2 flex-wrap mb-3">
        <select
          value={sortKey}
          onChange={(e) => setSortKey(e.target.value as SortKey)}
          className="text-sm rounded border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 px-2 py-1"
        >
          <option value="negativePct">Sort: % negative ↓</option>
          <option value="total">Sort: volume ↓</option>
          <option value="lastReview">Sort: last review ↓</option>
          <option value="sku">Sort: SKU A→Z</option>
        </select>
        <select
          value={marketplaceFilter}
          onChange={(e) => setMarketplaceFilter(e.target.value)}
          className="text-sm rounded border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 px-2 py-1"
        >
          <option value="">All marketplaces</option>
          {marketplaces.map((m) => (
            <option key={m} value={m}>
              {m}
            </option>
          ))}
        </select>
        <span className="ml-auto text-xs text-slate-500 dark:text-slate-400">
          {items.length} products
        </span>
      </div>

      <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-md overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-slate-50 dark:bg-slate-950/50 border-b border-slate-200 dark:border-slate-800">
            <tr className="text-left text-xs uppercase tracking-wider text-slate-500 dark:text-slate-400">
              <th className="px-3 py-2">SKU</th>
              <th className="px-3 py-2">Product</th>
              <th className="px-3 py-2">Mkt</th>
              <th className="px-3 py-2 text-right">Reviews</th>
              <th className="px-3 py-2 text-right">% negative</th>
              <th className="px-3 py-2">Top categories</th>
              <th className="px-3 py-2">Last</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-200 dark:divide-slate-800">
            {items.map((b) => (
              <tr key={b.productId} className="hover:bg-slate-50 dark:hover:bg-slate-950/40">
                <td className="px-3 py-2 font-mono text-xs">
                  <Link
                    href={`/marketing/reviews/products/${b.productId}`}
                    className="text-blue-600 dark:text-blue-400 hover:underline"
                  >
                    {b.product?.sku ?? b.productId.slice(0, 8)}
                  </Link>
                </td>
                <td className="px-3 py-2 max-w-[280px] truncate text-slate-700 dark:text-slate-300">
                  {b.product?.name ?? '—'}
                </td>
                <td className="px-3 py-2 text-[11px] font-mono text-slate-500">
                  {b.marketplaces.join(',') || '—'}
                </td>
                <td className="px-3 py-2 text-right tabular-nums">
                  <span className="text-slate-900 dark:text-slate-100">{b.total}</span>
                  <span className="text-[10px] text-slate-500 ml-1">
                    ({b.positive}/{b.neutral}/{b.negative})
                  </span>
                </td>
                <td className="px-3 py-2 text-right">
                  <NegativePctBadge pct={b.negativePct} />
                </td>
                <td className="px-3 py-2">
                  <div className="flex items-center gap-1 flex-wrap">
                    {b.topCategories.slice(0, 3).map((c) => (
                      <span
                        key={c.category}
                        className="text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded ring-1 ring-inset bg-rose-50 text-rose-700 ring-rose-200 dark:bg-rose-950/40 dark:text-rose-300 dark:ring-rose-900"
                      >
                        {CATEGORY_LABEL[c.category] ?? c.category} · {c.count}
                      </span>
                    ))}
                    {b.topCategories.length === 0 && (
                      <span className="text-[11px] text-slate-400">—</span>
                    )}
                  </div>
                </td>
                <td className="px-3 py-2 text-[11px] text-slate-500 dark:text-slate-400 tabular-nums">
                  {b.lastReviewAt
                    ? new Date(b.lastReviewAt).toLocaleDateString('en-GB', {
                        month: '2-digit',
                        day: '2-digit',
                      })
                    : '—'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

function NegativePctBadge({ pct }: { pct: number }) {
  if (pct === 0) {
    return (
      <span className="text-[11px] text-slate-400 tabular-nums">0%</span>
    )
  }
  const cls =
    pct >= 0.3
      ? 'bg-rose-100 text-rose-800 ring-rose-300 dark:bg-rose-950/60 dark:text-rose-200 dark:ring-rose-800'
      : pct >= 0.15
        ? 'bg-amber-100 text-amber-800 ring-amber-300 dark:bg-amber-950/60 dark:text-amber-200 dark:ring-amber-800'
        : 'bg-slate-50 text-slate-700 ring-slate-200 dark:bg-slate-800 dark:text-slate-300 dark:ring-slate-700'
  return (
    <span
      className={`inline-block text-[11px] uppercase tracking-wider px-1.5 py-0.5 rounded ring-1 ring-inset tabular-nums ${cls}`}
    >
      {(pct * 100).toFixed(1)}%
    </span>
  )
}
