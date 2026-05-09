'use client'

/**
 * W8.4b — Forecast bias card.
 *
 * Surfaces the W8.4 endpoint inline on the workspace. Operator sees
 * which SKUs are over/underforecasted at a glance — MAPE alone hides
 * direction (it's |error| so 50% over and 50% under look identical).
 *
 * Hides itself when there's nothing to show (cold install with no
 * ForecastAccuracy rows yet, or 0 SKUs cross the 5% deviation
 * threshold). Pure read; no apply-correction action — that's W8.4c.
 */

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { TrendingUp, TrendingDown, Minus, ExternalLink } from 'lucide-react'
import { useTranslations } from '@/lib/i18n/use-translations'
import { getBackendUrl } from '@/lib/backend-url'
import { cn } from '@/lib/utils'

interface BiasRow {
  sku: string
  samples: number
  biasPercent: number
  mapePercent: number | null
  withinBandRate: number | null
  direction: 'OVERFORECAST' | 'UNDERFORECAST' | 'CALIBRATED'
  lastEvaluatedDay: string | null
}

interface BiasResponse {
  params: { windowDays: number; minSamples: number; limit: number }
  totals: {
    skusEvaluated: number
    overforecast: number
    underforecast: number
    calibrated: number
  }
  skus: BiasRow[]
}

const DIRECTION_TONE: Record<BiasRow['direction'], string> = {
  OVERFORECAST:
    'bg-blue-50 text-blue-700 ring-blue-200 dark:bg-blue-950/40 dark:text-blue-300 dark:ring-blue-900',
  UNDERFORECAST:
    'bg-rose-50 text-rose-700 ring-rose-200 dark:bg-rose-950/40 dark:text-rose-300 dark:ring-rose-900',
  CALIBRATED:
    'bg-emerald-50 text-emerald-700 ring-emerald-200 dark:bg-emerald-950/40 dark:text-emerald-300 dark:ring-emerald-900',
}

const DIRECTION_ICON: Record<BiasRow['direction'], typeof TrendingUp> = {
  OVERFORECAST: TrendingUp,
  UNDERFORECAST: TrendingDown,
  CALIBRATED: Minus,
}

export function ForecastBiasCard() {
  const { t } = useTranslations()
  const [data, setData] = useState<BiasResponse | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    fetch(
      `${getBackendUrl()}/api/fulfillment/replenishment/forecast-bias?limit=20&minSamples=5`,
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
        {t('replenishment.forecastBias.loading')}
      </div>
    )
  }

  // Hide when there's no data to show — fresh installs / sparse
  // ForecastAccuracy / well-calibrated forecasts shouldn't clutter
  // the workspace.
  if (!data || data.skus.length === 0) return null

  const onlyCalibrated = data.skus.every((r) => r.direction === 'CALIBRATED')
  if (onlyCalibrated) return null

  return (
    <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-md">
      <div className="px-3 py-2 border-b border-slate-200 dark:border-slate-800 flex items-center gap-2 flex-wrap">
        <TrendingDown
          className="h-4 w-4 text-slate-500 dark:text-slate-400"
          aria-hidden="true"
        />
        <div className="text-sm font-medium text-slate-900 dark:text-slate-100">
          {t('replenishment.forecastBias.header.title')}
        </div>
        <div className="text-xs text-slate-500 dark:text-slate-400">
          {t('replenishment.forecastBias.header.summary', {
            window: data.params.windowDays,
            over: data.totals.overforecast,
            under: data.totals.underforecast,
            calibrated: data.totals.calibrated,
          })}
        </div>
      </div>

      <div className="overflow-x-auto">
        <table className="w-full text-xs">
          <thead className="border-b border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-950 text-[10px] uppercase tracking-wider text-slate-500 dark:text-slate-400">
            <tr>
              <th className="text-left px-3 py-1.5 font-semibold">
                {t('replenishment.forecastBias.col.sku')}
              </th>
              <th className="text-left px-3 py-1.5 font-semibold">
                {t('replenishment.forecastBias.col.direction')}
              </th>
              <th className="text-right px-3 py-1.5 font-semibold">
                {t('replenishment.forecastBias.col.bias')}
              </th>
              <th className="text-right px-3 py-1.5 font-semibold">
                {t('replenishment.forecastBias.col.mape')}
              </th>
              <th className="text-right px-3 py-1.5 font-semibold">
                {t('replenishment.forecastBias.col.withinBand')}
              </th>
              <th className="text-right px-3 py-1.5 font-semibold">
                {t('replenishment.forecastBias.col.samples')}
              </th>
              <th className="px-2 py-1.5"></th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-200 dark:divide-slate-800">
            {data.skus.map((r) => {
              const Icon = DIRECTION_ICON[r.direction]
              return (
                <tr
                  key={r.sku}
                  className="hover:bg-slate-50 dark:hover:bg-slate-950/50"
                >
                  <td className="px-3 py-1.5 font-medium text-slate-900 dark:text-slate-100">
                    {r.sku}
                  </td>
                  <td className="px-3 py-1.5">
                    <span
                      className={cn(
                        'text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded ring-1 ring-inset font-medium inline-flex items-center gap-1',
                        DIRECTION_TONE[r.direction],
                      )}
                    >
                      <Icon className="h-2.5 w-2.5" aria-hidden="true" />
                      {t(`replenishment.forecastBias.direction.${r.direction.toLowerCase()}`)}
                    </span>
                  </td>
                  <td
                    className={cn(
                      'px-3 py-1.5 text-right tabular-nums font-medium',
                      r.biasPercent > 0
                        ? 'text-blue-700 dark:text-blue-400'
                        : r.biasPercent < 0
                          ? 'text-rose-700 dark:text-rose-400'
                          : 'text-slate-600 dark:text-slate-400',
                    )}
                  >
                    {r.biasPercent > 0 ? '+' : ''}
                    {r.biasPercent.toFixed(1)}%
                  </td>
                  <td className="px-3 py-1.5 text-right tabular-nums text-slate-600 dark:text-slate-400">
                    {r.mapePercent != null ? `${r.mapePercent.toFixed(1)}%` : '—'}
                  </td>
                  <td className="px-3 py-1.5 text-right tabular-nums text-slate-600 dark:text-slate-400">
                    {r.withinBandRate != null
                      ? `${(r.withinBandRate * 100).toFixed(0)}%`
                      : '—'}
                  </td>
                  <td className="px-3 py-1.5 text-right tabular-nums text-slate-500 dark:text-slate-500">
                    {r.samples}
                  </td>
                  <td className="px-3 py-1.5 text-right">
                    <Link
                      href={`/products?search=${encodeURIComponent(r.sku)}`}
                      className="inline-flex items-center text-blue-600 dark:text-blue-400 hover:underline"
                      title={t('replenishment.forecastBias.openProduct')}
                    >
                      <ExternalLink className="h-3 w-3" aria-hidden="true" />
                    </Link>
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </div>
  )
}
