'use client'

/**
 * W3.2 — Command-center KPI strip.
 *
 * Lives between the pipeline-health strip (W1.5) and the urgency
 * tiles. Answers "what should I do today?" — distinct from the
 * pipeline strip which answers "is the system working?".
 *
 * Five tiles:
 *   1. Open POs              count + €total + oldest ETA
 *   2. Awaiting review       count + €total + critical-count badge
 *   3. Stockout risk (7d)    count of recs with <7d cover
 *   4. Working capital       €total tied up in inventory
 *   5. Forecast accuracy     30d avg %error + within-band rate
 *
 * Each tile is clickable when it makes sense:
 *   - Open POs → /fulfillment/purchase-orders
 *   - Awaiting → filter URL state to NEEDS_REORDER
 *   - Stockout risk → filter to CRITICAL
 *   - Forecast accuracy → /reports/forecast-accuracy (when it exists)
 *
 * Italian + dark mode + WCAG aria-labels.
 */

import { useEffect, useState } from 'react'
import Link from 'next/link'
import {
  Truck,
  ClipboardList,
  AlertTriangle,
  Banknote,
  Target,
  ChevronRight,
} from 'lucide-react'
import { useTranslations } from '@/lib/i18n/use-translations'
import { getBackendUrl } from '@/lib/backend-url'
import { cn } from '@/lib/utils'

interface KpiResponse {
  openPos: {
    count: number
    totalCents: number
    oldestExpectedDeliveryDate: string | null
  }
  recommendationsAwaitingReview: {
    count: number
    byUrgency: { CRITICAL: number; HIGH: number; MEDIUM: number; LOW: number }
    totalCents: number
  }
  stockoutRisk7d: { count: number }
  workingCapital: { totalCents: number }
  forecastAccuracy: {
    avgPercentError: number | null
    withinBandRate: number | null
    sampleCount: number
    windowDays: number
  }
}

function formatEur(cents: number): string {
  if (cents == null || !Number.isFinite(cents)) return '—'
  if (cents >= 1_000_000_00) return `€${(cents / 100_000_000).toFixed(1)}M`
  if (cents >= 1_000_00) return `€${(cents / 100_000).toFixed(1)}K`
  return `€${(cents / 100).toFixed(0)}`
}

export function CommandCenterKpis({ onFilterCritical }: { onFilterCritical?: () => void }) {
  const { t } = useTranslations()
  const [data, setData] = useState<KpiResponse | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    fetch(
      `${getBackendUrl()}/api/fulfillment/replenishment/command-center/kpis`,
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
      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-3">
        {Array.from({ length: 5 }).map((_, i) => (
          <div
            key={i}
            className="h-[78px] rounded-md border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-950 animate-pulse"
          />
        ))}
      </div>
    )
  }
  if (!data) return null

  const tileBase =
    'rounded-md border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 px-3 py-2.5 transition-colors hover:bg-slate-50 dark:hover:bg-slate-800/50'
  const labelClass =
    'text-[10px] uppercase tracking-wider text-slate-500 dark:text-slate-400 font-semibold inline-flex items-center gap-1.5'
  const valueClass =
    'text-xl font-semibold text-slate-900 dark:text-slate-100 mt-0.5 tabular-nums'
  const subClass = 'text-xs text-slate-500 dark:text-slate-400 mt-0.5'

  const acc = data.forecastAccuracy
  const accValue =
    acc.avgPercentError != null
      ? `${acc.avgPercentError.toFixed(1)}%`
      : '—'
  const accBandPct =
    acc.withinBandRate != null ? `${(acc.withinBandRate * 100).toFixed(0)}%` : null

  const stockoutCount = data.stockoutRisk7d.count
  const stockoutTone =
    stockoutCount === 0
      ? 'text-slate-900 dark:text-slate-100'
      : stockoutCount < 5
        ? 'text-amber-700 dark:text-amber-400'
        : 'text-rose-700 dark:text-rose-400'

  return (
    <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-3">
      <Link
        href="/fulfillment/purchase-orders"
        className={tileBase}
        aria-label={t('replenishment.kpi.openPos.ariaLabel')}
      >
        <div className={labelClass}>
          <Truck className="h-3 w-3" aria-hidden="true" />
          {t('replenishment.kpi.openPos.label')}
          <ChevronRight className="h-3 w-3 opacity-50 ml-auto" aria-hidden="true" />
        </div>
        <div className={valueClass}>{data.openPos.count.toLocaleString()}</div>
        <div className={subClass}>
          {formatEur(data.openPos.totalCents)}{' '}
          {data.openPos.oldestExpectedDeliveryDate &&
            t('replenishment.kpi.openPos.oldestEta', {
              date: new Date(data.openPos.oldestExpectedDeliveryDate)
                .toISOString()
                .slice(0, 10),
            })}
        </div>
      </Link>

      <button
        type="button"
        onClick={onFilterCritical}
        className={cn(tileBase, 'text-left')}
        aria-label={t('replenishment.kpi.awaiting.ariaLabel')}
      >
        <div className={labelClass}>
          <ClipboardList className="h-3 w-3" aria-hidden="true" />
          {t('replenishment.kpi.awaiting.label')}
        </div>
        <div className={valueClass}>
          {data.recommendationsAwaitingReview.count.toLocaleString()}
        </div>
        <div className={subClass}>
          {formatEur(data.recommendationsAwaitingReview.totalCents)}
          {data.recommendationsAwaitingReview.byUrgency.CRITICAL > 0 && (
            <span className="ml-1 text-rose-700 dark:text-rose-400 font-medium">
              · {data.recommendationsAwaitingReview.byUrgency.CRITICAL}{' '}
              {t('replenishment.urgency.critical').toLowerCase()}
            </span>
          )}
        </div>
      </button>

      <button
        type="button"
        onClick={onFilterCritical}
        className={cn(tileBase, 'text-left')}
        aria-label={t('replenishment.kpi.stockout.ariaLabel')}
      >
        <div className={labelClass}>
          <AlertTriangle className="h-3 w-3" aria-hidden="true" />
          {t('replenishment.kpi.stockout.label')}
        </div>
        <div className={cn(valueClass, stockoutTone)}>
          {stockoutCount.toLocaleString()}
        </div>
        <div className={subClass}>{t('replenishment.kpi.stockout.subtitle')}</div>
      </button>

      <div className={tileBase}>
        <div className={labelClass}>
          <Banknote className="h-3 w-3" aria-hidden="true" />
          {t('replenishment.kpi.workingCapital.label')}
        </div>
        <div className={valueClass}>{formatEur(data.workingCapital.totalCents)}</div>
        <div className={subClass}>{t('replenishment.kpi.workingCapital.subtitle')}</div>
      </div>

      <div className={tileBase}>
        <div className={labelClass}>
          <Target className="h-3 w-3" aria-hidden="true" />
          {t('replenishment.kpi.mape.label')}
        </div>
        <div className={valueClass}>{accValue}</div>
        <div className={subClass}>
          {acc.sampleCount > 0
            ? t('replenishment.kpi.mape.subtitle', {
                window: acc.windowDays,
                samples: acc.sampleCount,
                band: accBandPct ?? '—',
              })
            : t('replenishment.kpi.mape.empty', { window: acc.windowDays })}
        </div>
      </div>
    </div>
  )
}
