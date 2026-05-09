'use client'

import Link from 'next/link'
import { useState } from 'react'
import { ChevronRight } from 'lucide-react'
import { Card } from '@/components/ui/Card'
import { cn } from '@/lib/utils'
import { formatCurrency, NUM_FMT } from '../_lib/format'
import {
  CHANNEL_LABELS,
  type OverviewPayload,
  type T,
} from '../_lib/types'

/**
 * (Channel × Marketplace) matrix. Each cell carries three signals:
 *
 *   - Primary metric (revenue / orders / listings) — selected via
 *     the toggle in the header, large in the cell
 *   - Secondary line "Y orders · Z listings" (or whichever pair
 *     isn't the primary) — small below
 *
 * Marketplaces with no signal across any channel are filtered out
 * so the table stays tight. Cells link to /listings/<channel>?
 * marketplace=<m> so the operator drills into the slice that
 * caught their eye. The "∅" sentinel marketplace from orders that
 * lacked a marketplace tag is hidden — those rows muddy the
 * matrix without operational value.
 */

type Metric = 'revenue' | 'orders' | 'listings'

export default function MarketplaceMatrix({
  t,
  matrix,
  currency,
}: {
  t: T
  matrix: OverviewPayload['byMarketplace']
  currency: string
}) {
  const [metric, setMetric] = useState<Metric>('revenue')

  const cleaned = matrix.filter((m) => m.marketplace && m.marketplace !== '∅')
  const channels = Array.from(new Set(cleaned.map((m) => m.channel))).sort()
  const marketplaces = Array.from(
    new Set(cleaned.map((m) => m.marketplace)),
  ).sort()

  type Slot = { listings: number; orders: number; revenue: number }
  const lookup = new Map<string, Slot>()
  for (const m of cleaned) {
    lookup.set(`${m.channel}:${m.marketplace}`, {
      listings: m.listings,
      orders: m.orders,
      revenue: m.revenue,
    })
  }

  if (channels.length === 0) return null

  const formatPrimary = (slot: Slot): string => {
    if (metric === 'revenue') return formatCurrency(slot.revenue, currency)
    if (metric === 'orders') return NUM_FMT.format(slot.orders)
    return NUM_FMT.format(slot.listings)
  }

  const isEmptyForMetric = (slot: Slot): boolean => {
    if (metric === 'revenue') return slot.revenue <= 0
    if (metric === 'orders') return slot.orders <= 0
    return slot.listings <= 0
  }

  return (
    <Card
      title={t('overview.matrix.heading')}
      action={
        <div className="flex items-center gap-2">
          <div
            role="tablist"
            aria-label={t('overview.matrix.metricAria')}
            className="inline-flex items-center border border-slate-200 dark:border-slate-700 rounded-md p-0.5 bg-white dark:bg-slate-900"
          >
            {(['revenue', 'orders', 'listings'] as const).map((m) => (
              <button
                key={m}
                type="button"
                role="tab"
                aria-selected={m === metric}
                onClick={() => setMetric(m)}
                className={cn(
                  'h-6 px-2 text-xs rounded transition-colors',
                  'focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/40',
                  m === metric
                    ? 'bg-slate-900 dark:bg-slate-100 text-white dark:text-slate-900 font-semibold'
                    : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-100',
                )}
              >
                {t(`overview.matrix.metric.${m}`)}
              </button>
            ))}
          </div>
          <Link
            href="/listings"
            className="text-sm text-blue-600 hover:underline inline-flex items-center gap-1"
          >
            {t('overview.matrix.open')} <ChevronRight className="w-3 h-3" />
          </Link>
        </div>
      }
      noPadding
    >
      {/* DO.36 — wide table; on mobile it's scrollable horizontally
          via overflow-x-auto. The Card chrome stays unscrolled so
          the heading + metric toggle stay anchored above the
          scroll area. */}
      <div className="overflow-x-auto">
        <table className="w-full text-base min-w-[480px]">
          <thead className="bg-slate-50 dark:bg-slate-900/50">
            <tr>
              <th className="px-3 py-2 text-left text-xs uppercase tracking-wide text-slate-500 dark:text-slate-400 font-semibold">
                {t('overview.matrix.colChannel')}
              </th>
              {marketplaces.map((m) => (
                <th
                  key={m}
                  className="px-3 py-2 text-right text-xs uppercase tracking-wide text-slate-500 dark:text-slate-400 font-semibold font-mono"
                >
                  {m}
                </th>
              ))}
              <th className="px-3 py-2 text-right text-xs uppercase tracking-wide text-slate-500 dark:text-slate-400 font-semibold">
                {t('overview.matrix.colTotal')}
              </th>
            </tr>
          </thead>
          <tbody>
            {channels.map((c) => {
              const rowSlots = marketplaces.map((m) => lookup.get(`${c}:${m}`))
              const totalSlot: Slot = rowSlots.reduce<Slot>(
                (acc, s) =>
                  s
                    ? {
                        listings: acc.listings + s.listings,
                        orders: acc.orders + s.orders,
                        revenue: acc.revenue + s.revenue,
                      }
                    : acc,
                { listings: 0, orders: 0, revenue: 0 },
              )
              return (
                <tr
                  key={c}
                  className="border-t border-slate-100 dark:border-slate-800 hover:bg-slate-50/40 dark:hover:bg-slate-800/40"
                >
                  <td className="px-3 py-2 font-medium text-slate-900 dark:text-slate-100 align-top">
                    {CHANNEL_LABELS[c] ?? c}
                  </td>
                  {marketplaces.map((m) => {
                    const slot = lookup.get(`${c}:${m}`)
                    const empty = !slot || isEmptyForMetric(slot)
                    const cellContent = slot ? (
                      <>
                        <div
                          className={cn(
                            'tabular-nums text-sm',
                            empty
                              ? 'text-slate-300 dark:text-slate-600'
                              : 'text-slate-900 dark:text-slate-100 font-semibold',
                          )}
                        >
                          {formatPrimary(slot)}
                        </div>
                        {!empty && (slot.orders > 0 || slot.listings > 0) && (
                          <div className="text-xs text-slate-500 dark:text-slate-400 tabular-nums mt-0.5">
                            {metric !== 'orders' &&
                              t('overview.matrix.subOrders', {
                                n: NUM_FMT.format(slot.orders),
                              })}
                            {metric !== 'orders' &&
                              metric !== 'listings' &&
                              ' · '}
                            {metric !== 'listings' &&
                              metric !== 'orders' &&
                              t('overview.matrix.subListings', {
                                n: NUM_FMT.format(slot.listings),
                              })}
                            {metric === 'orders' &&
                              t('overview.matrix.subListings', {
                                n: NUM_FMT.format(slot.listings),
                              })}
                            {metric === 'listings' &&
                              t('overview.matrix.subOrders', {
                                n: NUM_FMT.format(slot.orders),
                              })}
                          </div>
                        )}
                      </>
                    ) : (
                      <span className="text-slate-300 dark:text-slate-600">
                        —
                      </span>
                    )
                    return (
                      <td
                        key={m}
                        className="px-3 py-2 text-right align-top"
                      >
                        {slot && !empty ? (
                          <Link
                            href={`/listings/${c.toLowerCase()}?marketplace=${m}`}
                            className="block hover:text-blue-600 group"
                          >
                            {cellContent}
                          </Link>
                        ) : (
                          cellContent
                        )}
                      </td>
                    )
                  })}
                  <td className="px-3 py-2 text-right font-semibold tabular-nums text-slate-900 dark:text-slate-100 align-top">
                    {formatPrimary(totalSlot)}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </Card>
  )
}
