'use client'

/**
 * SR.2 — Per-product review aggregates with negative-rate ranking.
 *
 * Sortable table: SKU / total / % negative / top categories / last review.
 * Default sort = negativePct desc with totalReviews tiebreaker so the
 * worst-performing SKUs surface first.
 *
 * The API session cookie lives on the API origin (cross-site setup) — the
 * Next server can never present it, so data MUST load client-side where the
 * fetch patch adds credentials. Server-side this page 401'd into the "No
 * reviews" empty state for everyone.
 */

import { useEffect, useState } from 'react'
import { Package } from 'lucide-react'
import { getBackendUrl } from '@/lib/backend-url'
import { ReviewsNav } from '../_shared/ReviewsNav'
import { ByProductClient } from './ByProductClient'

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

export default function ByProductPage() {
  const [items, setItems] = useState<ProductBucket[] | null>(null)

  useEffect(() => {
    let alive = true
    fetchByProduct().then((rows) => {
      if (alive) setItems(rows)
    })
    return () => { alive = false }
  }, [])

  return (
    <div className="px-4 py-4">
      <div className="flex items-start gap-3 mb-3">
        <Package className="h-6 w-6 text-blue-500 dark:text-blue-400 mt-0.5" />
        <div className="flex-1">
          <h1 className="text-xl font-semibold text-slate-900 dark:text-slate-100">
            Reviews by Product
          </h1>
          <p className="text-sm text-slate-500 dark:text-slate-400">
            Aggregates for the last 30 days. Sort by % negative to surface worst-performing
            SKUs, or by last review for recency tracking. Click a SKU to drill down.
          </p>
        </div>
      </div>
      <ReviewsNav />
      {items === null ? (
        <div aria-busy="true" className="h-64 rounded-md border border-default dark:border-slate-800 bg-slate-100 dark:bg-slate-800 animate-pulse" />
      ) : items.length === 0 ? (
        <div className="bg-white dark:bg-slate-900 border border-default dark:border-slate-800 rounded-md px-4 py-6 text-center text-sm text-slate-500">
          No reviews linked to products in the last 30 days.
        </div>
      ) : (
        <ByProductClient initial={items} />
      )}
    </div>
  )
}
