/**
 * SR.2 — Per-product review aggregates with negative-rate ranking.
 *
 * Sortable table: SKU / total / % negative / top categories / last review.
 * Default sort = negativePct desc with totalReviews tiebreaker so the
 * worst-performing SKUs surface first.
 */

import { Package } from 'lucide-react'
import { getBackendUrl } from '@/lib/backend-url'
import { ReviewsNav } from '../_shared/ReviewsNav'
import { ByProductClient } from './ByProductClient'

export const dynamic = 'force-dynamic'

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

async function fetchByProduct(): Promise<ProductBucket[]> {
  try {
    const res = await fetch(
      `${getBackendUrl()}/api/reviews/by-product?sinceDays=30&sort=negativePct&limit=200`,
      { cache: 'no-store' },
    )
    if (!res.ok) return []
    const json = (await res.json()) as { items: ProductBucket[] }
    return json.items
  } catch {
    return []
  }
}

export default async function ByProductPage() {
  const items = await fetchByProduct()
  return (
    <div className="px-4 py-4">
      <div className="flex items-start gap-3 mb-3">
        <Package className="h-6 w-6 text-blue-500 dark:text-blue-400 mt-0.5" />
        <div className="flex-1">
          <h1 className="text-xl font-semibold text-slate-900 dark:text-slate-100">
            Recensioni per prodotto
          </h1>
          <p className="text-sm text-slate-500 dark:text-slate-400">
            Aggregati ultimi 30 giorni. Ordina per % negative per scoprire gli SKU peggiori,
            o per ultima recensione per tracking. Click sullo SKU per il drill-down.
          </p>
        </div>
      </div>
      <ReviewsNav />
      {items.length === 0 ? (
        <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-md px-4 py-6 text-center text-sm text-slate-500">
          Nessuna recensione collegata a prodotti negli ultimi 30 giorni.
        </div>
      ) : (
        <ByProductClient initial={items} />
      )}
    </div>
  )
}
