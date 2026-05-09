'use client'

import Link from 'next/link'
import { formatCurrency, NUM_FMT } from '../_lib/format'
import type { OverviewPayload, T } from '../_lib/types'

/**
 * Top 10 SKUs by revenue in the active window. Each row links to
 * the product editor when a productId is present (orphan-line items
 * with a SKU but no product reference still render, just non-link).
 */
export default function TopProducts({
  t,
  items,
  currency,
}: {
  t: T
  items: OverviewPayload['topProducts']
  currency: string
}) {
  if (items.length === 0) return null
  const max = Math.max(1, ...items.map((i) => i.revenue))
  return (
    <div className="border border-slate-200 rounded-lg bg-white">
      <div className="px-4 py-3 border-b border-slate-100">
        <h2 className="text-md font-semibold text-slate-900">
          {t('overview.top.heading')}
        </h2>
      </div>
      <ul>
        {items.map((it) => {
          const pct = (it.revenue / max) * 100
          return (
            <li
              key={it.sku}
              className="px-4 py-2 border-b border-slate-100 last:border-b-0"
            >
              <div className="flex items-center justify-between gap-3">
                {it.productId ? (
                  <Link
                    href={`/products/${it.productId}/edit`}
                    className="font-mono text-base text-blue-600 hover:underline truncate"
                  >
                    {it.sku}
                  </Link>
                ) : (
                  <span className="font-mono text-base text-slate-700 truncate">
                    {it.sku}
                  </span>
                )}
                <div className="flex items-center gap-3 flex-shrink-0">
                  <span className="text-sm text-slate-500 tabular-nums">
                    {t('overview.top.units', { n: NUM_FMT.format(it.units) })}
                  </span>
                  <span className="text-base font-semibold text-slate-900 tabular-nums">
                    {formatCurrency(it.revenue, currency)}
                  </span>
                </div>
              </div>
              <div className="mt-1 h-1 rounded-full bg-slate-100 overflow-hidden">
                <div
                  className="h-full bg-emerald-400"
                  style={{ width: `${pct}%` }}
                />
              </div>
            </li>
          )
        })}
      </ul>
    </div>
  )
}
