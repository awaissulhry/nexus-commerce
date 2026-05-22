'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { ChevronLeft, Maximize2, Minimize2 } from 'lucide-react'
import {
  KPICard,
  TrendChart,
  formatCurrency,
  formatNum,
  trendColor,
} from '@/components/insights'
import { Card } from '@/components/ui/Card'
import { cn } from '@/lib/utils'
import { getBackendUrl } from '@/lib/backend-url'
import { PushHealthChip } from '@/components/dashboard/PushHealthChip'
import { PushLatencyWidget } from '@/components/dashboard/PushLatencyWidget'

interface LiveSummary {
  currency: string
  totals: {
    revenue: { current: number; previous: number; deltaPct: number | null }
    orders: { current: number; previous: number; deltaPct: number | null }
    units: { current: number; previous: number; deltaPct: number | null }
    aov: { current: number; previous: number; deltaPct: number | null }
  }
  spark: Array<{ date: string; revenue: number; orders: number }>
}

interface LiveAdvertising {
  totals: { spend: number; sales: number; acos: number | null; roas: number | null }
}

interface LiveAnomalies {
  summary: { critical: number; attention: number; info: number }
}

export default function LiveClient() {
  const [summary, setSummary] = useState<LiveSummary | null>(null)
  const [ads, setAds] = useState<LiveAdvertising | null>(null)
  const [anomalies, setAnomalies] = useState<LiveAnomalies | null>(null)
  const [fullscreen, setFullscreen] = useState(false)
  const [lastRefreshedAt, setLastRefreshedAt] = useState<Date | null>(null)
  const [tick, setTick] = useState(0)

  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), 60_000)
    return () => clearInterval(id)
  }, [])

  useEffect(() => {
    let cancelled = false
    async function load() {
      try {
        const base = getBackendUrl()
        const [sumRes, adRes, anomRes] = await Promise.all([
          fetch(`${base}/api/insights/summary?window=today&compare=dod`, {
            credentials: 'include',
          }),
          fetch(`${base}/api/insights/advertising?window=today&compare=dod`, {
            credentials: 'include',
          }),
          fetch(`${base}/api/insights/anomalies?window=7d`, {
            credentials: 'include',
          }),
        ])
        if (!sumRes.ok || !adRes.ok || !anomRes.ok) return
        const s: LiveSummary = await sumRes.json()
        const a: LiveAdvertising = await adRes.json()
        const an: LiveAnomalies = await anomRes.json()
        if (!cancelled) {
          setSummary(s)
          setAds(a)
          setAnomalies(an)
          setLastRefreshedAt(new Date())
        }
      } catch {
        /* swallow — live mode keeps showing last known */
      }
    }
    load()
    return () => {
      cancelled = true
    }
  }, [tick])

  function toggleFullscreen() {
    if (typeof document === 'undefined') return
    if (!document.fullscreenElement) {
      document.documentElement.requestFullscreen?.()
      setFullscreen(true)
    } else {
      document.exitFullscreen?.()
      setFullscreen(false)
    }
  }

  const currency = summary?.currency ?? 'EUR'

  return (
    <div
      className={cn(
        'max-w-[1800px] mx-auto p-6 transition-all',
        fullscreen && 'min-h-screen bg-slate-950 text-slate-100',
      )}
    >
      <div className="mb-2 flex items-center justify-between">
        <Link
          href="/insights"
          className={cn(
            'inline-flex items-center gap-1 text-xs hover:text-slate-700',
            fullscreen ? 'text-slate-400' : 'text-slate-500',
          )}
        >
          <ChevronLeft className="w-3 h-3" />
          Insights
        </Link>
        <div className="flex items-center gap-3">
          {/* RT.1 — push-health chip on the Live monitor header so the
              operator can see at a glance whether the pipeline feeding
              the KPIs is alive. Hidden in TV-mode chrome since the
              fullscreen view is for at-a-glance KPIs. */}
          {!fullscreen && <PushHealthChip />}
          {lastRefreshedAt && (
            <span
              className={cn(
                'text-[11px] tabular-nums',
                fullscreen ? 'text-slate-400' : 'text-slate-500',
              )}
            >
              Refreshed {lastRefreshedAt.toLocaleTimeString('it-IT')}
            </span>
          )}
          <button
            type="button"
            onClick={toggleFullscreen}
            className={cn(
              'inline-flex items-center gap-1.5 h-7 px-2.5 text-sm rounded-md border',
              fullscreen
                ? 'border-slate-700 text-slate-300 hover:bg-slate-800'
                : 'border-slate-200 text-slate-700 hover:bg-slate-50',
            )}
          >
            {fullscreen ? (
              <Minimize2 className="w-3.5 h-3.5" />
            ) : (
              <Maximize2 className="w-3.5 h-3.5" />
            )}
            {fullscreen ? 'Exit TV mode' : 'TV mode'}
          </button>
        </div>
      </div>

      <div className="mb-5">
        <h1
          className={cn(
            'text-3xl font-semibold mb-1',
            fullscreen ? 'text-slate-100' : 'text-slate-900',
          )}
        >
          Live monitor
        </h1>
        <p
          className={cn(
            'text-sm',
            fullscreen ? 'text-slate-400' : 'text-slate-500',
          )}
        >
          Today's KPIs vs yesterday — auto-refreshes every 60 seconds.
        </p>
      </div>

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-5">
        <KPICard
          label="Revenue today"
          value={
            summary ? formatCurrency(summary.totals.revenue.current, currency) : '…'
          }
          deltaPct={summary?.totals.revenue.deltaPct ?? null}
          series={summary?.spark.map((p) => p.revenue)}
          accent="emerald"
        />
        <KPICard
          label="Orders today"
          value={summary ? formatNum(summary.totals.orders.current) : '…'}
          deltaPct={summary?.totals.orders.deltaPct ?? null}
          series={summary?.spark.map((p) => p.orders)}
          accent="blue"
        />
        <KPICard
          label="Ad spend today"
          value={ads ? formatCurrency(ads.totals.spend, currency) : '…'}
          accent="violet"
          invertDelta
        />
        <KPICard
          label="ROAS today"
          value={
            ads?.totals.roas != null ? `${ads.totals.roas.toFixed(2)}x` : '…'
          }
          accent="amber"
        />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-3 mb-5">
        <Card
          title="Hourly trend (today)"
          className={cn(fullscreen && 'lg:col-span-3')}
          noPadding
        >
          <div className="p-4">
            {summary && summary.spark.length > 0 ? (
              <TrendChart
                data={summary.spark.map((p) => ({
                  date: p.date,
                  revenue: p.revenue,
                  orders: p.orders,
                }))}
                series={[
                  {
                    key: 'revenue',
                    label: 'Revenue',
                    color: trendColor(0),
                    format: 'currency',
                  },
                  {
                    key: 'orders',
                    label: 'Orders',
                    color: trendColor(1),
                    dashed: true,
                    format: 'number',
                    yAxisId: 'right',
                  },
                ]}
                currency={currency}
                variant="area"
                height={fullscreen ? 360 : 260}
                rightAxisFormat="number"
              />
            ) : (
              <div className="h-[260px] flex items-center justify-center text-slate-400 text-sm">
                Waiting for today's data…
              </div>
            )}
          </div>
        </Card>
        {!fullscreen && (
          <Card title="Anomalies — last 7d">
            <div className="flex flex-col gap-2">
              <Tile
                label="Critical"
                value={anomalies?.summary.critical ?? '…'}
                tone="rose"
              />
              <Tile
                label="Attention"
                value={anomalies?.summary.attention ?? '…'}
                tone="amber"
              />
              <Tile
                label="Info"
                value={anomalies?.summary.info ?? '…'}
                tone="blue"
              />
              <Link
                href="/insights/anomalies"
                className="text-xs text-blue-600 hover:underline self-start"
              >
                Investigate →
              </Link>
            </div>
          </Card>
        )}
      </div>

      {/* RT.3 — push-latency dashboard. Hidden in TV-mode (the
          fullscreen view is for at-a-glance business KPIs; ops
          signal would clutter it). */}
      {!fullscreen && (
        <div className="mb-5">
          <PushLatencyWidget />
        </div>
      )}
    </div>
  )
}

function Tile({
  label,
  value,
  tone,
}: {
  label: string
  value: number | string
  tone: 'rose' | 'amber' | 'blue'
}) {
  const tones: Record<typeof tone, string> = {
    rose: 'border-rose-300 bg-rose-50 dark:bg-rose-950/30 text-rose-700 dark:text-rose-300',
    amber: 'border-amber-300 bg-amber-50 dark:bg-amber-950/30 text-amber-700 dark:text-amber-300',
    blue: 'border-blue-300 bg-blue-50 dark:bg-blue-950/30 text-blue-700 dark:text-blue-300',
  }
  return (
    <div className={cn('rounded-md border px-3 py-2 flex items-center justify-between', tones[tone])}>
      <span className="text-xs font-semibold uppercase tracking-wider">
        {label}
      </span>
      <span className="text-xl font-bold tabular-nums">{value}</span>
    </div>
  )
}
