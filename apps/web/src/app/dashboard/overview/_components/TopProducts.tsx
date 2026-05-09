'use client'

import Link from 'next/link'
import { Card } from '@/components/ui/Card'
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
    <Card title={t('overview.top.heading')} noPadding>
      <ul>
        {items.map((it) => {
          const pct = (it.revenue / max) * 100
          return (
            <li
              key={it.sku}
              className="px-4 py-2 border-b border-slate-100 dark:border-slate-800 last:border-b-0"
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
                  <span className="font-mono text-base text-slate-700 dark:text-slate-300 truncate">
                    {it.sku}
                  </span>
                )}
                <div className="flex items-center gap-3 flex-shrink-0">
                  <span className="text-sm text-slate-500 dark:text-slate-400 tabular-nums">
                    {t('overview.top.units', { n: NUM_FMT.format(it.units) })}
                  </span>
                  <span className="text-base font-semibold text-slate-900 dark:text-slate-100 tabular-nums">
                    {formatCurrency(it.revenue, currency)}
                  </span>
                </div>
              </div>
              <div className="mt-1 h-1 rounded-full bg-slate-100 dark:bg-slate-800 overflow-hidden">
                <div
                  className="h-full bg-emerald-400"
                  style={{ width: `${pct}%` }}
                />
              </div>
            </li>
          )
        })}
      </ul>
    </Card>
  )
}
