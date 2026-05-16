'use client'

import { useEffect, useState } from 'react'
import { Loader2, TrendingUp, Package, Star, AlertTriangle, CheckCircle2 } from 'lucide-react'
import { getBackendUrl } from '@/lib/backend-url'

interface SalesChannel {
  channel: string
  marketplace: string | null
  units: number
  revenue: number
  orders: number
  avgConversionRate: number
  avgBuyBoxPct: number
  avgSessionCount: number
}

interface ProductAnalytics {
  productId: string
  sku: string
  days: number
  sales: {
    totalUnits: number
    totalRevenue: number
    totalOrders: number
    avgDailyUnits: number
    stockoutDays: number
    byChannel: SalesChannel[]
  }
  inventory: {
    totalAvailable: number
    daysOfInventory: number | null
    stockoutRisk: 'HIGH' | 'MEDIUM' | 'LOW' | 'UNKNOWN'
  }
  pricing: {
    currentPrices: Array<{ channel: string; marketplace: string | null; price: number }>
    latestBuyBoxPrices: Array<{ channel: string; marketplace: string | null; buyBoxPrice: number | null }>
    latestRepricingDecision: { newPrice: number; reason: string; applied: boolean } | null
  }
  quality: {
    latestScore: number | null
    latestScoreAt: string | null
    byChannel: Array<{ channel: string; score: number; dimensions: Record<string, number> }>
  }
  reviews: {
    avgRating: number | null
    reviewCount: number
    recentSpikeCount: number
  }
}

interface TrendPoint {
  day: string
  units: number
  revenue: number
  sessions: number | null
  conversionRate: number | null
  buyBoxPct: number | null
}

const CHANNEL_COLORS: Record<string, string> = {
  AMAZON: 'text-amber-700 dark:text-amber-400',
  EBAY: 'text-blue-700 dark:text-blue-400',
  SHOPIFY: 'text-emerald-700 dark:text-emerald-400',
}

const RISK_STYLES: Record<string, string> = {
  HIGH: 'bg-rose-50 text-rose-700 ring-rose-200 dark:bg-rose-950/40 dark:text-rose-300 dark:ring-rose-900',
  MEDIUM: 'bg-amber-50 text-amber-700 ring-amber-200 dark:bg-amber-950/40 dark:text-amber-300 dark:ring-amber-900',
  LOW: 'bg-emerald-50 text-emerald-700 ring-emerald-200 dark:bg-emerald-950/40 dark:text-emerald-300 dark:ring-emerald-900',
  UNKNOWN: 'bg-slate-100 text-slate-500 ring-slate-200 dark:bg-slate-800 dark:text-slate-400 dark:ring-slate-700',
}

function scoreColor(score: number): string {
  if (score >= 75) return 'text-emerald-700 dark:text-emerald-400'
  if (score >= 50) return 'text-amber-700 dark:text-amber-400'
  return 'text-rose-700 dark:text-rose-400'
}

function fmt(n: number, digits = 2): string {
  return `€${n.toFixed(digits)}`
}

function pct(n: number): string {
  return `${(n * 100).toFixed(1)}%`
}

// CSS sparkline — no external chart library
function Sparkline({ values, colorClass }: { values: number[]; colorClass: string }) {
  if (!values.length) return <span className="text-slate-400 text-xs">—</span>
  const max = Math.max(...values, 1)
  return (
    <div className="flex items-end gap-0.5 h-8">
      {values.map((v, i) => (
        <div
          key={i}
          className={`w-3 rounded-sm ${colorClass}`}
          style={{ height: `${Math.max((v / max) * 100, 4)}%` }}
          title={String(v)}
        />
      ))}
    </div>
  )
}

export function AnalyticsTab({ productId }: { productId: string }) {
  const [analytics, setAnalytics] = useState<ProductAnalytics | null>(null)
  const [trend, setTrend] = useState<TrendPoint[]>([])
  const [days, setDays] = useState(30)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    setLoading(true)
    setError(null)
    const backend = getBackendUrl()
    Promise.all([
      fetch(`${backend}/api/products/${productId}/analytics?days=${days}`),
      fetch(`${backend}/api/products/${productId}/analytics/trend?days=${days}`),
    ])
      .then(async ([aRes, tRes]) => {
        if (!aRes.ok) throw new Error(`HTTP ${aRes.status}`)
        const [aJson, tJson] = await Promise.all([aRes.json(), tRes.json()])
        setAnalytics((aJson as { analytics: ProductAnalytics }).analytics)
        setTrend((tJson as { trend: TrendPoint[] }).trend)
      })
      .catch((e) => setError(e instanceof Error ? e.message : 'Failed to load analytics'))
      .finally(() => setLoading(false))
  }, [productId, days])

  if (loading) {
    return (
      <div className="flex items-center justify-center py-16 text-slate-400">
        <Loader2 className="h-5 w-5 animate-spin mr-2" />
        Loading analytics…
      </div>
    )
  }

  if (error || !analytics) {
    return (
      <div className="flex items-center justify-center py-16 text-slate-500 text-sm">
        {error ?? 'No analytics data available'}
      </div>
    )
  }

  const trendUnits = trend.map((t) => t.units)
  const trendRevenue = trend.map((t) => t.revenue)

  return (
    <div className="space-y-5">
      {/* Day selector */}
      <div className="flex items-center gap-2">
        {([7, 30, 90] as const).map((d) => (
          <button
            key={d}
            type="button"
            onClick={() => setDays(d)}
            className={`px-2.5 py-1 text-xs rounded-full ring-1 ring-inset transition-colors ${
              days === d
                ? 'bg-violet-600 text-white ring-violet-600'
                : 'bg-white dark:bg-slate-900 text-slate-600 dark:text-slate-400 ring-slate-300 dark:ring-slate-700 hover:bg-slate-50'
            }`}
          >
            {d}d
          </button>
        ))}
        <span className="text-xs text-slate-400 ml-1">trailing window</span>
      </div>

      {/* KPI strip */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <KpiCard label={`Units sold (${days}d)`} value={analytics.sales.totalUnits.toLocaleString()} />
        <KpiCard label={`Revenue (${days}d)`} value={fmt(analytics.sales.totalRevenue)} />
        <KpiCard label="Avg daily units" value={analytics.sales.avgDailyUnits.toFixed(1)} />
        <KpiCard label="Stockout days" value={String(analytics.sales.stockoutDays)} warn={analytics.sales.stockoutDays > 0} />
      </div>

      {/* Trend sparklines */}
      {trend.length > 0 && (
        <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-md px-4 py-3">
          <h3 className="text-xs font-medium text-slate-500 uppercase tracking-wider mb-3">
            Trend (last {trend.length} days)
          </h3>
          <div className="grid grid-cols-2 gap-4">
            <div>
              <div className="text-[10px] text-slate-400 mb-1">Revenue</div>
              <Sparkline values={trendRevenue} colorClass="bg-violet-400 dark:bg-violet-500" />
            </div>
            <div>
              <div className="text-[10px] text-slate-400 mb-1">Units</div>
              <Sparkline values={trendUnits} colorClass="bg-slate-300 dark:bg-slate-600" />
            </div>
          </div>
        </div>
      )}

      {/* By channel table */}
      {analytics.sales.byChannel.length > 0 && (
        <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-md overflow-hidden">
          <div className="px-4 py-2 border-b border-slate-200 dark:border-slate-800 flex items-center gap-2">
            <TrendingUp className="h-4 w-4 text-slate-400" />
            <h3 className="text-xs font-medium text-slate-700 dark:text-slate-300 uppercase tracking-wider">
              By channel
            </h3>
          </div>
          <table className="w-full text-sm">
            <thead className="bg-slate-50 dark:bg-slate-800/60">
              <tr>
                {['Channel', 'Units', 'Revenue', 'Conv%', 'Buy Box%', 'Sessions/day'].map((h) => (
                  <th key={h} className="px-3 py-1.5 text-left text-[10px] uppercase tracking-wider text-slate-500 font-medium">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-200 dark:divide-slate-800">
              {analytics.sales.byChannel.map((ch) => (
                <tr key={`${ch.channel}:${ch.marketplace}`} className="hover:bg-slate-50 dark:hover:bg-slate-800/40">
                  <td className="px-3 py-2">
                    <span className={`text-xs font-medium ${CHANNEL_COLORS[ch.channel] ?? ''}`}>{ch.channel}</span>
                    {ch.marketplace && <span className="text-[10px] text-slate-400 ml-1">{ch.marketplace}</span>}
                  </td>
                  <td className="px-3 py-2 text-xs tabular-nums">{ch.units}</td>
                  <td className="px-3 py-2 text-xs tabular-nums">{fmt(ch.revenue)}</td>
                  <td className="px-3 py-2 text-xs tabular-nums">{ch.avgConversionRate > 0 ? pct(ch.avgConversionRate) : '—'}</td>
                  <td className="px-3 py-2 text-xs tabular-nums">{ch.avgBuyBoxPct > 0 ? `${ch.avgBuyBoxPct.toFixed(0)}%` : '—'}</td>
                  <td className="px-3 py-2 text-xs tabular-nums">{ch.avgSessionCount > 0 ? ch.avgSessionCount : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Quality + Inventory + Repricing row */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        {/* Listing quality */}
        <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-md px-4 py-3">
          <div className="flex items-center gap-2 mb-2">
            <Star className="h-4 w-4 text-slate-400" />
            <h3 className="text-xs font-medium text-slate-700 dark:text-slate-300 uppercase tracking-wider">Quality</h3>
          </div>
          {analytics.quality.byChannel.length === 0 ? (
            <p className="text-xs text-slate-400">No scores yet — run quality check in List Wizard.</p>
          ) : (
            <div className="space-y-2">
              {analytics.quality.byChannel.map((q) => (
                <div key={q.channel}>
                  <div className="flex items-center justify-between mb-1">
                    <span className={`text-[10px] font-medium ${CHANNEL_COLORS[q.channel] ?? ''}`}>{q.channel}</span>
                    <span className={`text-sm font-semibold tabular-nums ${scoreColor(q.score)}`}>{q.score}/100</span>
                  </div>
                  {Object.entries(q.dimensions).map(([dim, score]) => (
                    <div key={dim} className="flex items-center gap-2 mb-0.5">
                      <span className="text-[10px] text-slate-400 w-16 shrink-0">{dim}</span>
                      <div className="flex-1 h-1.5 bg-slate-100 dark:bg-slate-800 rounded-full overflow-hidden">
                        <div
                          className={`h-full rounded-full ${score >= 75 ? 'bg-emerald-500' : score >= 50 ? 'bg-amber-500' : 'bg-rose-500'}`}
                          style={{ width: `${score}%` }}
                        />
                      </div>
                      <span className="text-[10px] tabular-nums text-slate-500 w-6 text-right">{score}</span>
                    </div>
                  ))}
                </div>
              ))}
              {analytics.quality.latestScoreAt && (
                <p className="text-[10px] text-slate-400 mt-1">
                  Scored {new Date(analytics.quality.latestScoreAt).toLocaleDateString('en-GB', { month: 'short', day: 'numeric' })}
                </p>
              )}
            </div>
          )}
        </div>

        {/* Inventory health */}
        <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-md px-4 py-3">
          <div className="flex items-center gap-2 mb-2">
            <Package className="h-4 w-4 text-slate-400" />
            <h3 className="text-xs font-medium text-slate-700 dark:text-slate-300 uppercase tracking-wider">Inventory</h3>
          </div>
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <span className="text-xs text-slate-500">Available</span>
              <span className="text-sm font-semibold tabular-nums text-slate-900 dark:text-slate-100">
                {analytics.inventory.totalAvailable.toLocaleString()} units
              </span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-xs text-slate-500">Days on hand</span>
              <span className="text-sm font-semibold tabular-nums text-slate-900 dark:text-slate-100">
                {analytics.inventory.daysOfInventory != null ? `${analytics.inventory.daysOfInventory}d` : '—'}
              </span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-xs text-slate-500">Stockout risk</span>
              <span className={`text-[10px] font-medium px-1.5 py-0.5 rounded-full ring-1 ring-inset ${RISK_STYLES[analytics.inventory.stockoutRisk]}`}>
                {analytics.inventory.stockoutRisk === 'HIGH' && <AlertTriangle className="h-3 w-3 inline mr-0.5" />}
                {analytics.inventory.stockoutRisk}
              </span>
            </div>
          </div>
        </div>

        {/* Repricing context */}
        <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-md px-4 py-3">
          <div className="flex items-center gap-2 mb-2">
            <TrendingUp className="h-4 w-4 text-slate-400" />
            <h3 className="text-xs font-medium text-slate-700 dark:text-slate-300 uppercase tracking-wider">Repricing</h3>
          </div>
          {analytics.pricing.latestRepricingDecision ? (
            <div className="space-y-1.5">
              <div className="flex items-center gap-2">
                <span className="text-xs text-slate-500">Latest decision</span>
                <span className="text-sm font-semibold tabular-nums text-slate-900 dark:text-slate-100">
                  €{analytics.pricing.latestRepricingDecision.newPrice.toFixed(2)}
                </span>
                {analytics.pricing.latestRepricingDecision.applied ? (
                  <span className="inline-flex items-center gap-0.5 text-[10px] text-emerald-700 dark:text-emerald-400">
                    <CheckCircle2 className="h-3 w-3" /> Applied
                  </span>
                ) : (
                  <span className="text-[10px] text-amber-700 dark:text-amber-400">Logged</span>
                )}
              </div>
              <p className="text-xs text-slate-500 line-clamp-2">{analytics.pricing.latestRepricingDecision.reason}</p>
            </div>
          ) : (
            <p className="text-xs text-slate-400">No repricing rule configured.</p>
          )}
          {analytics.pricing.currentPrices.length > 0 && (
            <div className="mt-3 space-y-1">
              <div className="text-[10px] text-slate-400 uppercase tracking-wider">Current prices</div>
              {analytics.pricing.currentPrices.slice(0, 3).map((p) => (
                <div key={`${p.channel}:${p.marketplace}`} className="flex items-center justify-between">
                  <span className={`text-[10px] ${CHANNEL_COLORS[p.channel] ?? ''}`}>
                    {p.channel}{p.marketplace ? ` ${p.marketplace}` : ''}
                  </span>
                  <span className="text-xs tabular-nums font-medium text-slate-700 dark:text-slate-300">€{p.price.toFixed(2)}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Review spikes */}
      {analytics.reviews.recentSpikeCount > 0 && (
        <div className="flex items-center gap-2 px-4 py-3 rounded-md bg-rose-50 dark:bg-rose-950/40 border border-rose-200 dark:border-rose-900">
          <AlertTriangle className="h-4 w-4 text-rose-600 dark:text-rose-400 shrink-0" />
          <p className="text-sm text-rose-700 dark:text-rose-300">
            {analytics.reviews.recentSpikeCount} open review spike{analytics.reviews.recentSpikeCount !== 1 ? 's' : ''} detected for this product.
          </p>
        </div>
      )}
    </div>
  )
}

function KpiCard({ label, value, warn }: { label: string; value: string; warn?: boolean }) {
  return (
    <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-md px-3 py-2">
      <div className="text-[10px] uppercase tracking-wider text-slate-500 dark:text-slate-400">{label}</div>
      <div className={`text-xl font-semibold tabular-nums ${warn ? 'text-rose-700 dark:text-rose-400' : 'text-slate-900 dark:text-slate-100'}`}>
        {value}
      </div>
    </div>
  )
}
