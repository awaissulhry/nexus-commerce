'use client'

import Link from 'next/link'
import { AlertTriangle, ChevronRight, Sparkles } from 'lucide-react'
import { Card } from '@/components/ui/Card'
import { cn } from '@/lib/utils'
import { NUM_FMT } from '../_lib/format'
import type { OverviewPayload, T } from '../_lib/types'

/**
 * DO.31 — predictive insights surfaced from the forecast cron's
 * ReplenishmentForecast table.
 *
 * Three signals:
 *   - forecast units, next 7 days
 *   - forecast units, next 30 days
 *   - SKUs at risk of stocking out within 7d (forecast > current
 *     stock). Rose tint when non-zero — direct revenue loss
 *     signal that the operator should act on before it lands.
 *
 * Hidden when the cron hasn't produced data yet (fresh deploy
 * before NEXUS_ENABLE_FORECAST_CRON wakes up). `generatedAt`
 * tells the operator when the figures were computed.
 */
export default function PredictivePanel({
  t,
  predictive,
}: {
  t: T
  predictive: OverviewPayload['predictive']
}) {
  const hasForecast =
    predictive.forecastUnits7d > 0 ||
    predictive.forecastUnits30d > 0 ||
    predictive.stockoutRisk7d > 0
  if (!hasForecast) return null

  const generatedLabel = predictive.generatedAt
    ? t('overview.predictive.generatedAt', {
        date: new Date(predictive.generatedAt).toLocaleString('it-IT'),
      })
    : null

  return (
    <Card
      title={
        <span className="inline-flex items-center gap-1.5">
          <Sparkles className="w-3.5 h-3.5 text-violet-500" />
          {t('overview.predictive.heading')}
        </span>
      }
      action={
        <Link
          href="/fulfillment/replenishment"
          className="text-sm text-blue-600 hover:underline inline-flex items-center gap-1"
        >
          {t('overview.predictive.openAll')} <ChevronRight className="w-3 h-3" />
        </Link>
      }
    >
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <div>
          <div className="text-xs uppercase tracking-wide text-slate-500 dark:text-slate-400 font-medium">
            {t('overview.predictive.forecast7d')}
          </div>
          <div className="mt-0.5 text-xl font-semibold text-slate-900 dark:text-slate-100 tabular-nums">
            {NUM_FMT.format(Math.round(predictive.forecastUnits7d))}
          </div>
          <div className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">
            {t('overview.predictive.unitsHint')}
          </div>
        </div>
        <div>
          <div className="text-xs uppercase tracking-wide text-slate-500 dark:text-slate-400 font-medium">
            {t('overview.predictive.forecast30d')}
          </div>
          <div className="mt-0.5 text-xl font-semibold text-slate-900 dark:text-slate-100 tabular-nums">
            {NUM_FMT.format(Math.round(predictive.forecastUnits30d))}
          </div>
          <div className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">
            {t('overview.predictive.unitsHint')}
          </div>
        </div>
        <Link
          href="/fulfillment/replenishment"
          className={cn(
            'block rounded-md p-1 -m-1 transition-colors',
            'focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/40',
            predictive.stockoutRisk7d > 0
              ? 'hover:bg-rose-50/50 dark:hover:bg-rose-950/30'
              : 'hover:bg-slate-50 dark:hover:bg-slate-800',
          )}
        >
          <div className="text-xs uppercase tracking-wide text-slate-500 dark:text-slate-400 font-medium inline-flex items-center gap-1">
            {predictive.stockoutRisk7d > 0 && (
              <AlertTriangle className="w-3 h-3 text-rose-500" />
            )}
            {t('overview.predictive.stockoutRisk')}
          </div>
          <div
            className={cn(
              'mt-0.5 text-xl font-semibold tabular-nums',
              predictive.stockoutRisk7d > 0
                ? 'text-rose-700 dark:text-rose-400'
                : 'text-slate-900 dark:text-slate-100',
            )}
          >
            {NUM_FMT.format(predictive.stockoutRisk7d)}
          </div>
          <div className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">
            {t('overview.predictive.stockoutHint')}
          </div>
        </Link>
      </div>
      {generatedLabel && (
        <div className="mt-3 pt-2 border-t border-slate-100 dark:border-slate-800 text-xs text-slate-400 dark:text-slate-500">
          {generatedLabel}
        </div>
      )}
    </Card>
  )
}
