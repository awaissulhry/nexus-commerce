'use client'

/**
 * W9.6n — Forecast diagnostic cards (R.1 + R.2 origins).
 *
 * Extracted from ReplenishmentWorkspace.tsx. Two related cards:
 *
 * 1. ForecastAccuracyCard — drawer-scoped, per-SKU MAPE/MAE/calibration
 *    over the last 30d, plus a per-regime split (so we can see whether
 *    HOLT_WINTERS is actually beating the fallbacks for this SKU).
 *
 * 2. ForecastHealthCard — workspace-level aggregate. Sits alongside
 *    the urgency tiles so operators can spot model drift at a glance.
 *    Aggregate MAPE + per-regime breakdown + tiny daily-MAPE trend
 *    sparkline. Suppresses entirely when there's no data yet.
 *
 * Adds dark-mode classes throughout.
 */

import { useEffect, useState } from 'react'
import { RefreshCw } from 'lucide-react'
import { Card } from '@/components/ui/Card'
import { getBackendUrl } from '@/lib/backend-url'

interface ForecastAccuracyData {
  sampleCount?: number
  mape?: number | null
  mae?: number | null
  bandCalibration?: number | null
  byRegime?: Record<string, { mape: number | null; sampleCount: number }>
}

interface ForecastHealthOverall {
  sampleCount?: number
  mape?: number | null
  bandCalibration?: number | null
}

interface ForecastHealthData {
  overall?: ForecastHealthOverall
  groups?: Array<{ key: string; mape: number | null; sampleCount: number }>
  trend?: Array<{ day: string; mape: number | null }>
  worstSku?: { sku: string; mape: number; sampleCount: number } | null
}

export function ForecastAccuracyCard({
  sku,
  channel,
  marketplace,
}: {
  sku: string | null
  channel: string | null
  marketplace: string | null
}) {
  const [data, setData] = useState<ForecastAccuracyData | null>(null)
  const [loading, setLoading] = useState(true)
  useEffect(() => {
    if (!sku) return
    setLoading(true)
    const qs = new URLSearchParams({ sku, windowDays: '30' })
    if (channel) qs.set('channel', channel)
    if (marketplace) qs.set('marketplace', marketplace)
    fetch(
      `${getBackendUrl()}/api/fulfillment/replenishment/forecast-accuracy?${qs.toString()}`,
      { cache: 'no-store' },
    )
      .then((r) => (r.ok ? r.json() : null))
      .then(setData)
      .catch(() => setData(null))
      .finally(() => setLoading(false))
  }, [sku, channel, marketplace])

  if (!sku) return null
  if (loading) {
    return (
      <div>
        <div className="text-sm uppercase tracking-wider text-slate-500 dark:text-slate-400 font-semibold mb-1">
          Forecast accuracy (last 30d)
        </div>
        <div className="text-base text-slate-400 dark:text-slate-500">
          Loading…
        </div>
      </div>
    )
  }
  if (!data) return null

  const sampleCount = data.sampleCount ?? 0
  if (sampleCount < 7) {
    return (
      <div>
        <div className="text-sm uppercase tracking-wider text-slate-500 dark:text-slate-400 font-semibold mb-1">
          Forecast accuracy (last 30d)
        </div>
        <div className="text-base text-slate-500 dark:text-slate-400 italic">
          Not enough history yet (n={sampleCount}). Need ≥7 days.
        </div>
      </div>
    )
  }

  const mape = data.mape == null ? '—' : `${Number(data.mape).toFixed(1)}%`
  const mae = data.mae == null ? '—' : `${Number(data.mae).toFixed(2)}`
  const cal =
    data.bandCalibration == null
      ? '—'
      : `${Number(data.bandCalibration).toFixed(0)}%`
  const regimes = Object.entries(data.byRegime ?? {})
    .filter(([, s]) => s.sampleCount >= 3)
    .sort((a, b) => b[1].sampleCount - a[1].sampleCount)

  return (
    <div>
      <div className="text-sm uppercase tracking-wider text-slate-500 dark:text-slate-400 font-semibold mb-1">
        Forecast accuracy (last 30d)
      </div>
      <div className="grid grid-cols-3 gap-2 text-base mb-2">
        <div className="border border-slate-200 dark:border-slate-800 rounded px-2 py-1 bg-slate-50 dark:bg-slate-900">
          <div className="uppercase tracking-wider text-xs text-slate-500 dark:text-slate-400 font-semibold">
            MAPE
          </div>
          <div className="tabular-nums font-semibold text-slate-900 dark:text-slate-100">
            {mape}
          </div>
        </div>
        <div className="border border-slate-200 dark:border-slate-800 rounded px-2 py-1 bg-slate-50 dark:bg-slate-900">
          <div className="uppercase tracking-wider text-xs text-slate-500 dark:text-slate-400 font-semibold">
            MAE
          </div>
          <div className="tabular-nums font-semibold text-slate-900 dark:text-slate-100">
            {mae}
          </div>
        </div>
        <div className="border border-slate-200 dark:border-slate-800 rounded px-2 py-1 bg-slate-50 dark:bg-slate-900">
          <div className="uppercase tracking-wider text-xs text-slate-500 dark:text-slate-400 font-semibold">
            Calibration
          </div>
          <div className="tabular-nums font-semibold text-slate-900 dark:text-slate-100">
            {cal}{' '}
            <span className="text-xs text-slate-500 dark:text-slate-400 font-normal">
              / 80%
            </span>
          </div>
        </div>
      </div>
      <div className="text-xs text-slate-500 dark:text-slate-400">
        n = {sampleCount} days
      </div>
      {regimes.length > 1 && (
        <div className="mt-2">
          <div className="uppercase tracking-wider text-xs text-slate-500 dark:text-slate-400 font-semibold mb-1">
            By regime
          </div>
          <ul className="space-y-0.5">
            {regimes.map(([key, s]) => (
              <li
                key={key}
                className="flex items-center justify-between text-sm"
              >
                <span className="font-mono text-slate-700 dark:text-slate-300">
                  {key}
                </span>
                <span className="tabular-nums text-slate-700 dark:text-slate-300">
                  {s.mape == null ? '—' : `${Number(s.mape).toFixed(1)}%`}{' '}
                  <span className="text-slate-400 dark:text-slate-500">
                    (n={s.sampleCount})
                  </span>
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}

export function ForecastHealthCard() {
  const [data, setData] = useState<ForecastHealthData | null>(null)
  const [loading, setLoading] = useState(true)
  const [refreshTick, setRefreshTick] = useState(0)
  useEffect(() => {
    setLoading(true)
    fetch(
      `${getBackendUrl()}/api/fulfillment/replenishment/forecast-accuracy/aggregate?windowDays=30&groupBy=regime`,
      { cache: 'no-store' },
    )
      .then((r) => (r.ok ? r.json() : null))
      .then(setData)
      .catch(() => setData(null))
      .finally(() => setLoading(false))
  }, [refreshTick])

  if (loading || !data?.overall) return null
  const sampleCount = data.overall.sampleCount ?? 0
  if (sampleCount === 0) return null

  const mape =
    data.overall.mape == null
      ? '—'
      : `${Number(data.overall.mape).toFixed(1)}%`
  const cal =
    data.overall.bandCalibration == null
      ? '—'
      : `${Number(data.overall.bandCalibration).toFixed(0)}%`
  const groups = data.groups ?? []
  const trend = data.trend ?? []
  const sparkPoints = trend
    .filter((t) => t.mape != null)
    .map((t) => Number(t.mape))
  const sparkMax = sparkPoints.length > 0 ? Math.max(...sparkPoints, 1) : 1

  return (
    <Card>
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div>
          <div className="text-sm uppercase tracking-wider text-slate-500 dark:text-slate-400 font-semibold">
            Forecast health (last 30d)
          </div>
          <div className="mt-1 flex items-baseline gap-3">
            <span className="text-[20px] font-semibold tabular-nums text-slate-900 dark:text-slate-100">
              {mape}
            </span>
            <span className="text-sm text-slate-500 dark:text-slate-400">
              MAPE · n={sampleCount}
            </span>
            <span className="text-sm text-slate-500 dark:text-slate-400">
              Calibration {cal} / 80%
            </span>
          </div>
          {data.worstSku && (
            <div className="text-sm text-slate-500 dark:text-slate-400 mt-0.5">
              Worst:{' '}
              <span className="font-mono">{data.worstSku.sku}</span> (
              {Number(data.worstSku.mape).toFixed(1)}% MAPE, n=
              {data.worstSku.sampleCount})
            </div>
          )}
        </div>
        <button
          onClick={() => setRefreshTick((n) => n + 1)}
          className="h-7 px-2 text-sm border border-slate-200 dark:border-slate-700 rounded hover:bg-slate-50 dark:hover:bg-slate-800 text-slate-700 dark:text-slate-300 inline-flex items-center gap-1"
          title="Refresh"
        >
          <RefreshCw size={11} /> Refresh
        </button>
      </div>
      {groups.length > 0 && (
        <div className="mt-3 grid grid-cols-2 sm:grid-cols-4 gap-2 text-sm">
          {groups.map((g) => (
            <div
              key={g.key}
              className="border border-slate-200 dark:border-slate-800 rounded px-2 py-1.5"
            >
              <div className="uppercase tracking-wider text-xs text-slate-500 dark:text-slate-400 font-semibold">
                {g.key}
              </div>
              <div className="tabular-nums font-semibold text-slate-900 dark:text-slate-100 mt-0.5">
                {g.mape == null ? '—' : `${Number(g.mape).toFixed(1)}%`}
              </div>
              <div className="text-xs text-slate-500 dark:text-slate-400">
                n={g.sampleCount}
              </div>
            </div>
          ))}
        </div>
      )}
      {sparkPoints.length > 1 && (
        <div className="mt-3">
          <div className="uppercase tracking-wider text-xs text-slate-500 dark:text-slate-400 font-semibold mb-1">
            Daily MAPE trend
          </div>
          <svg
            viewBox={`0 0 ${sparkPoints.length * 8} 24`}
            className="w-full h-6"
          >
            <polyline
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
              className="text-blue-600 dark:text-blue-400"
              points={sparkPoints
                .map((p, i) => `${i * 8},${24 - (p / sparkMax) * 20}`)
                .join(' ')}
            />
          </svg>
        </div>
      )}
    </Card>
  )
}
