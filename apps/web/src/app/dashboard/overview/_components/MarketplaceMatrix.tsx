'use client'

import Link from 'next/link'
import { ChevronRight } from 'lucide-react'
import { Card } from '@/components/ui/Card'
import { cn } from '@/lib/utils'
import {
  CHANNEL_LABELS,
  type OverviewPayload,
  type T,
} from '../_lib/types'

/**
 * Listings by (channel × marketplace). Each cell links to the
 * channel-specific listings view filtered by that marketplace.
 */
export default function MarketplaceMatrix({
  t,
  matrix,
}: {
  t: T
  matrix: OverviewPayload['byMarketplace']
}) {
  const channels = Array.from(new Set(matrix.map((m) => m.channel))).sort()
  const marketplaces = Array.from(
    new Set(matrix.map((m) => m.marketplace)),
  ).sort()
  const lookup = new Map<string, number>()
  for (const m of matrix) lookup.set(`${m.channel}:${m.marketplace}`, m.listings)
  if (channels.length === 0) return null
  return (
    <Card
      title={t('overview.matrix.heading')}
      action={
        <Link
          href="/bulk-operations"
          className="text-sm text-blue-600 hover:underline inline-flex items-center gap-1"
        >
          {t('overview.matrix.open')} <ChevronRight className="w-3 h-3" />
        </Link>
      }
      noPadding
    >
      <div className="overflow-x-auto">
        <table className="w-full text-base">
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
              const total = marketplaces.reduce(
                (s, m) => s + (lookup.get(`${c}:${m}`) ?? 0),
                0,
              )
              return (
                <tr
                  key={c}
                  className="border-t border-slate-100 dark:border-slate-800 hover:bg-slate-50/40 dark:hover:bg-slate-800/40"
                >
                  <td className="px-3 py-1.5 font-medium text-slate-900 dark:text-slate-100">
                    {CHANNEL_LABELS[c] ?? c}
                  </td>
                  {marketplaces.map((m) => {
                    const v = lookup.get(`${c}:${m}`) ?? 0
                    return (
                      <td
                        key={m}
                        className={cn(
                          'px-3 py-1.5 text-right tabular-nums',
                          v === 0
                            ? 'text-slate-300 dark:text-slate-600'
                            : 'text-slate-700 dark:text-slate-300',
                        )}
                      >
                        {v > 0 ? (
                          <Link
                            href={`/listings/${c.toLowerCase()}?marketplace=${m}`}
                            className="hover:text-blue-600 hover:underline"
                          >{v}</Link>
                        ) : v}
                      </td>
                    )
                  })}
                  <td className="px-3 py-1.5 text-right font-semibold tabular-nums text-slate-900 dark:text-slate-100">
                    {total}
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
