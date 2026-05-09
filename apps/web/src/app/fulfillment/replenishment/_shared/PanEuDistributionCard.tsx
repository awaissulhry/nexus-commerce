'use client'

/**
 * W7.2 — Pan-EU FBA distribution card.
 *
 * Surfaces the W7.1 recommender output as an actionable list. Each
 * row shows a (surplus marketplace) → (shortage marketplace) transfer
 * suggestion with current + post-rebalance days-of-cover at both ends.
 *
 * Hides itself when there are no imbalances (clean install / well-
 * balanced inventory). Loads on mount; no auto-refresh because the
 * underlying FBA inventory is synced every 15 min by the existing
 * S.25 cron — refetching more often would just hit the same cache.
 */

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { Globe, ArrowRight, ExternalLink } from 'lucide-react'
import { useTranslations } from '@/lib/i18n/use-translations'
import { getBackendUrl } from '@/lib/backend-url'
import { cn } from '@/lib/utils'

interface PanEuRec {
  productId: string | null
  sku: string
  productName: string | null
  surplus: {
    marketplaceId: string
    sellableUnits: number
    velocityPerDay: number
    daysOfCover: number | null
  }
  shortage: {
    marketplaceId: string
    sellableUnits: number
    velocityPerDay: number
    daysOfCover: number | null
  }
  transferUnits: number
  newDaysOfCoverSurplus: number | null
  newDaysOfCoverShortage: number | null
}

interface PanEuResponse {
  totals: {
    skusFlagged: number
    totalTransferUnits: number
    totalSurplusUnits: number
    totalShortageMarketplaces: number
  }
  recommendations: PanEuRec[]
}

function fmtCover(d: number | null): string {
  if (d == null) return '∞'
  if (d < 1) return '<1d'
  if (d < 100) return `${Math.round(d)}d`
  return `${Math.round(d / 7)}w`
}

const COVER_TONE = (d: number | null): string => {
  if (d == null) return 'text-slate-500 dark:text-slate-500'
  if (d < 7) return 'text-rose-700 dark:text-rose-400'
  if (d < 30) return 'text-amber-700 dark:text-amber-400'
  if (d > 60) return 'text-blue-700 dark:text-blue-400'
  return 'text-emerald-700 dark:text-emerald-400'
}

export function PanEuDistributionCard() {
  const { t } = useTranslations()
  const [data, setData] = useState<PanEuResponse | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    fetch(
      `${getBackendUrl()}/api/fulfillment/replenishment/pan-eu/imbalances`,
      { cache: 'no-store' },
    )
      .then((r) => (r.ok ? r.json() : null))
      .then((json) => {
        if (!cancelled) setData(json)
      })
      .catch(() => {
        if (!cancelled) setData(null)
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [])

  if (loading && !data) {
    return (
      <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-md px-3 py-2 text-xs text-slate-500">
        {t('replenishment.panEu.loading')}
      </div>
    )
  }

  // Hide the card when inventory is balanced — no need to clutter
  // the workspace with a "you're balanced" empty state.
  if (!data || data.recommendations.length === 0) return null

  return (
    <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-md">
      <div className="px-3 py-2 border-b border-slate-200 dark:border-slate-800 flex items-center gap-2 flex-wrap">
        <Globe
          className="h-4 w-4 text-slate-500 dark:text-slate-400"
          aria-hidden="true"
        />
        <div className="text-sm font-medium text-slate-900 dark:text-slate-100">
          {t('replenishment.panEu.header.title')}
        </div>
        <div className="text-xs text-slate-500 dark:text-slate-400">
          {t('replenishment.panEu.header.summary', {
            skus: data.totals.skusFlagged,
            units: data.totals.totalTransferUnits.toLocaleString(),
            markets: data.totals.totalShortageMarketplaces,
          })}
        </div>
      </div>

      <div className="overflow-x-auto">
        <table className="w-full text-xs">
          <thead className="border-b border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-950 text-[10px] uppercase tracking-wider text-slate-500 dark:text-slate-400">
            <tr>
              <th className="text-left px-3 py-1.5 font-semibold">
                {t('replenishment.panEu.col.sku')}
              </th>
              <th className="text-left px-3 py-1.5 font-semibold">
                {t('replenishment.panEu.col.surplus')}
              </th>
              <th className="px-2 py-1.5"></th>
              <th className="text-left px-3 py-1.5 font-semibold">
                {t('replenishment.panEu.col.shortage')}
              </th>
              <th className="text-right px-3 py-1.5 font-semibold">
                {t('replenishment.panEu.col.transfer')}
              </th>
              <th className="text-right px-3 py-1.5 font-semibold">
                {t('replenishment.panEu.col.newCover')}
              </th>
              <th className="px-2 py-1.5"></th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-200 dark:divide-slate-800">
            {data.recommendations.map((rec) => (
              <tr
                key={rec.sku}
                className="hover:bg-slate-50 dark:hover:bg-slate-950/50"
              >
                <td className="px-3 py-1.5">
                  <div className="font-medium text-slate-900 dark:text-slate-100">
                    {rec.sku}
                  </div>
                  {rec.productName && (
                    <div className="text-[10px] text-slate-500 dark:text-slate-400 line-clamp-1">
                      {rec.productName}
                    </div>
                  )}
                </td>
                <td className="px-3 py-1.5">
                  <div className="font-medium text-slate-900 dark:text-slate-100">
                    {rec.surplus.marketplaceId}
                  </div>
                  <div className="text-[10px] text-slate-500 dark:text-slate-400">
                    {t('replenishment.panEu.cell.unitsCover', {
                      units: rec.surplus.sellableUnits.toLocaleString(),
                      cover: fmtCover(rec.surplus.daysOfCover),
                    })}
                  </div>
                </td>
                <td className="px-1 py-1.5 text-slate-400">
                  <ArrowRight className="h-3.5 w-3.5" aria-hidden="true" />
                </td>
                <td className="px-3 py-1.5">
                  <div className="font-medium text-slate-900 dark:text-slate-100">
                    {rec.shortage.marketplaceId}
                  </div>
                  <div className="text-[10px] text-slate-500 dark:text-slate-400">
                    <span className={COVER_TONE(rec.shortage.daysOfCover)}>
                      {t('replenishment.panEu.cell.unitsCover', {
                        units: rec.shortage.sellableUnits.toLocaleString(),
                        cover: fmtCover(rec.shortage.daysOfCover),
                      })}
                    </span>
                  </div>
                </td>
                <td className="px-3 py-1.5 text-right tabular-nums font-semibold text-slate-900 dark:text-slate-100">
                  {rec.transferUnits.toLocaleString()}
                </td>
                <td className="px-3 py-1.5 text-right tabular-nums">
                  <div className={cn('text-[11px]', COVER_TONE(rec.newDaysOfCoverSurplus))}>
                    {fmtCover(rec.newDaysOfCoverSurplus)}
                  </div>
                  <div
                    className={cn(
                      'text-[10px]',
                      COVER_TONE(rec.newDaysOfCoverShortage),
                    )}
                  >
                    →{' '}
                    {fmtCover(rec.newDaysOfCoverShortage)}
                  </div>
                </td>
                <td className="px-3 py-1.5 text-right">
                  {rec.productId && (
                    <Link
                      href={`/products/${rec.productId}`}
                      className="inline-flex items-center text-blue-600 dark:text-blue-400 hover:underline"
                      title={t('replenishment.panEu.openProduct')}
                    >
                      <ExternalLink className="h-3 w-3" aria-hidden="true" />
                    </Link>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}
