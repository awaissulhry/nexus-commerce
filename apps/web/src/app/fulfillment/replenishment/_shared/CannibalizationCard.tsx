'use client'

/**
 * W8.3b — Cannibalization card.
 *
 * Surfaces the W8.3 detector inline. For each recently-launched
 * SKU that pulled demand away from related SKUs (productType /
 * brand match), shows the new SKU + the affected siblings + their
 * pre/post velocity drop.
 *
 * Hides itself when there are no findings — clean install / no
 * recent launches / well-behaved substitution all leave the card
 * silent. Pure read; operator decides whether to phase out, mark
 * down, or leave the older SKU alone.
 */

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { Repeat, ArrowDown, ExternalLink } from 'lucide-react'
import { useTranslations } from '@/lib/i18n/use-translations'
import { getBackendUrl } from '@/lib/backend-url'
import { cn } from '@/lib/utils'

interface Candidate {
  sku: string
  productType: string | null
  brand: string | null
  preVelocityPerDay: number
  postVelocityPerDay: number
  velocityDelta: number
  velocityDeltaPercent: number
  preSamples: number
  postSamples: number
}

interface Finding {
  newSku: string
  newProductId: string | null
  newProductType: string | null
  newBrand: string | null
  launchDay: string
  candidates: Candidate[]
}

interface CannibalizationResponse {
  totals: { newSkusFlagged: number; totalCandidates: number }
  findings: Finding[]
}

export function CannibalizationCard() {
  const { t } = useTranslations()
  const [data, setData] = useState<CannibalizationResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [expandedSku, setExpandedSku] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    fetch(
      `${getBackendUrl()}/api/fulfillment/replenishment/cannibalization`,
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
        {t('replenishment.cannibalization.loading')}
      </div>
    )
  }

  if (!data || data.findings.length === 0) return null

  return (
    <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-md">
      <div className="px-3 py-2 border-b border-slate-200 dark:border-slate-800 flex items-center gap-2 flex-wrap">
        <Repeat
          className="h-4 w-4 text-slate-500 dark:text-slate-400"
          aria-hidden="true"
        />
        <div className="text-sm font-medium text-slate-900 dark:text-slate-100">
          {t('replenishment.cannibalization.header.title')}
        </div>
        <div className="text-xs text-slate-500 dark:text-slate-400">
          {t('replenishment.cannibalization.header.summary', {
            launches: data.totals.newSkusFlagged,
            candidates: data.totals.totalCandidates,
          })}
        </div>
      </div>

      <ul className="divide-y divide-slate-200 dark:divide-slate-800">
        {data.findings.map((f) => {
          const expanded = expandedSku === f.newSku
          return (
            <li key={f.newSku}>
              <button
                type="button"
                onClick={() => setExpandedSku(expanded ? null : f.newSku)}
                aria-expanded={expanded}
                className="w-full text-left px-3 py-2 flex items-start gap-3 hover:bg-slate-50 dark:hover:bg-slate-950/50"
              >
                <ArrowDown
                  className="h-4 w-4 text-rose-500 dark:text-rose-400 mt-0.5"
                  aria-hidden="true"
                />
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-sm font-medium text-slate-900 dark:text-slate-100">
                      {f.newSku}
                    </span>
                    <span className="text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded ring-1 ring-inset bg-violet-50 text-violet-700 ring-violet-200 dark:bg-violet-950/40 dark:text-violet-300 dark:ring-violet-900">
                      {t('replenishment.cannibalization.cell.newLaunch')}
                    </span>
                    {f.newProductType && (
                      <span className="text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded ring-1 ring-inset bg-slate-50 text-slate-600 ring-slate-200 dark:bg-slate-800 dark:text-slate-400 dark:ring-slate-700">
                        {f.newProductType}
                      </span>
                    )}
                  </div>
                  <div className="text-[11px] text-slate-500 dark:text-slate-400 mt-0.5">
                    {t('replenishment.cannibalization.cell.findingSummary', {
                      n: f.candidates.length,
                      day: f.launchDay.slice(0, 10),
                    })}
                  </div>
                </div>
                {f.newProductId && (
                  <Link
                    href={`/products/${f.newProductId}/edit`}
                    onClick={(e) => e.stopPropagation()}
                    className="inline-flex items-center text-blue-600 dark:text-blue-400 hover:underline"
                    title={t('replenishment.cannibalization.openProduct')}
                  >
                    <ExternalLink className="h-3 w-3" aria-hidden="true" />
                  </Link>
                )}
              </button>

              {expanded && (
                <div className="px-3 pb-3 pl-10 overflow-x-auto">
                  <table className="w-full text-xs">
                    <thead className="text-[10px] uppercase tracking-wider text-slate-500 dark:text-slate-400">
                      <tr>
                        <th className="text-left px-2 py-1 font-semibold">
                          {t('replenishment.cannibalization.col.affectedSku')}
                        </th>
                        <th className="text-right px-2 py-1 font-semibold">
                          {t('replenishment.cannibalization.col.preVelocity')}
                        </th>
                        <th className="text-right px-2 py-1 font-semibold">
                          {t('replenishment.cannibalization.col.postVelocity')}
                        </th>
                        <th className="text-right px-2 py-1 font-semibold">
                          {t('replenishment.cannibalization.col.delta')}
                        </th>
                        <th className="text-right px-2 py-1 font-semibold">
                          {t('replenishment.cannibalization.col.samples')}
                        </th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-200 dark:divide-slate-800">
                      {f.candidates.map((c) => (
                        <tr
                          key={c.sku}
                          className="hover:bg-slate-50 dark:hover:bg-slate-950/50"
                        >
                          <td className="px-2 py-1 font-medium text-slate-900 dark:text-slate-100">
                            {c.sku}
                          </td>
                          <td className="px-2 py-1 text-right tabular-nums text-slate-600 dark:text-slate-400">
                            {c.preVelocityPerDay.toFixed(2)}
                          </td>
                          <td className="px-2 py-1 text-right tabular-nums text-slate-600 dark:text-slate-400">
                            {c.postVelocityPerDay.toFixed(2)}
                          </td>
                          <td
                            className={cn(
                              'px-2 py-1 text-right tabular-nums font-medium',
                              c.velocityDeltaPercent < -50
                                ? 'text-rose-700 dark:text-rose-400'
                                : 'text-amber-700 dark:text-amber-400',
                            )}
                          >
                            {c.velocityDeltaPercent.toFixed(0)}%
                          </td>
                          <td className="px-2 py-1 text-right tabular-nums text-slate-500 dark:text-slate-500">
                            {c.preSamples}/{c.postSamples}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </li>
          )
        })}
      </ul>
    </div>
  )
}
