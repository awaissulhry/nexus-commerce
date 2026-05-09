'use client'

// R7.1 — Returns analytics workspace.
//
// Operators land here from /fulfillment/returns via a "View
// analytics" link or Cmd+K. Single page, no drawer; charts +
// tables only. Data comes from the extended /returns/analytics
// endpoint that R7.1 added.

import { useCallback, useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { ArrowLeft, TrendingUp, TrendingDown, Clock, Tag, Box, Loader2, BarChart3, AlertTriangle } from 'lucide-react'
import { ResponsiveContainer, BarChart, Bar, XAxis, YAxis, Tooltip, CartesianGrid } from 'recharts'
import PageHeader from '@/components/layout/PageHeader'
import { Card } from '@/components/ui/Card'
import { EmptyState } from '@/components/ui/EmptyState'
import { getBackendUrl } from '@/lib/backend-url'

type Analytics = {
  windowDays: number
  last30: number
  prior30: number
  trendPct: number | null
  byChannel: Array<{ channel: string; count: number }>
  topReasons: Array<{ reason: string; count: number }>
  fbaCount: number
  warehouseCount: number
  totalCount: number
  returnRateByChannel: Array<{ channel: string; returns: number; orders: number; ratePct: number | null }>
  topReturnSkus: Array<{ sku: string; returnCount: number; unitsReturned: number }>
  avgProcessingDays: number | null
  avgProcessingSampleSize: number
  dailyTrend: Array<{ date: string; count: number }>
}

// R7.2 — risk-score row from /returns/risk-scores.
type RiskScore = {
  sku: string
  productName: string | null
  productType: string | null
  returnCount: number
  orderCount: number
  ratePct: number
  bucketMeanPct: number
  bucketStdDev: number
  z: number
  flagged: boolean
}
type RiskScoreResponse = {
  windowDays: number
  scored: RiskScore[]
  flagged: RiskScore[]
  summary: { skusScored: number; bucketsAnalyzed: number; flaggedCount: number }
}

const CHANNEL_TONE: Record<string, string> = {
  AMAZON: 'bg-orange-50 text-orange-700 border-orange-200',
  EBAY: 'bg-blue-50 dark:bg-blue-950/40 text-blue-700 dark:text-blue-300 border-blue-200 dark:border-blue-900',
  SHOPIFY: 'bg-emerald-50 dark:bg-emerald-950/40 text-emerald-700 dark:text-emerald-300 border-emerald-200 dark:border-emerald-900',
  WOOCOMMERCE: 'bg-violet-50 dark:bg-violet-950/40 text-violet-700 dark:text-violet-300 border-violet-200 dark:border-violet-900',
  ETSY: 'bg-rose-50 dark:bg-rose-950/40 text-rose-700 dark:text-rose-300 border-rose-200 dark:border-rose-900',
}

export default function AnalyticsClient() {
  const [data, setData] = useState<Analytics | null>(null)
  const [risk, setRisk] = useState<RiskScoreResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const fetchAnalytics = useCallback(async () => {
    setLoading(true)
    try {
      const [analyticsRes, riskRes] = await Promise.all([
        fetch(`${getBackendUrl()}/api/fulfillment/returns/analytics`, { cache: 'no-store' }),
        fetch(`${getBackendUrl()}/api/fulfillment/returns/risk-scores`, { cache: 'no-store' }),
      ])
      if (analyticsRes.ok) setData((await analyticsRes.json()) as Analytics)
      else setError(`HTTP ${analyticsRes.status}`)
      // Risk endpoint failure is non-fatal — page still renders the
      // rest. Surface as an empty card.
      if (riskRes.ok) setRisk((await riskRes.json()) as RiskScoreResponse)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Load failed')
    } finally {
      setLoading(false)
    }
  }, [])
  useEffect(() => { void fetchAnalytics() }, [fetchAnalytics])

  // Re-format the daily trend with short MM-DD labels for the chart.
  const trendData = useMemo(() => {
    if (!data) return []
    return data.dailyTrend.map((d) => ({
      date: d.date.slice(5), // MM-DD
      count: d.count,
    }))
  }, [data])

  if (loading) {
    return (
      <div className="space-y-5">
        <PageHeader
          title="Returns analytics"
          description="Rates, top reasons, processing time."
          breadcrumbs={[{ label: 'Fulfillment', href: '/fulfillment' }, { label: 'Returns', href: '/fulfillment/returns' }, { label: 'Analytics' }]}
        />
        <Card>
          <div className="py-12 text-center text-slate-500 dark:text-slate-400 inline-flex items-center gap-2 justify-center w-full">
            <Loader2 size={16} className="animate-spin" /> Loading…
          </div>
        </Card>
      </div>
    )
  }

  if (error || !data) {
    return (
      <div className="space-y-5">
        <PageHeader
          title="Returns analytics"
          breadcrumbs={[{ label: 'Fulfillment', href: '/fulfillment' }, { label: 'Returns', href: '/fulfillment/returns' }, { label: 'Analytics' }]}
        />
        <Card>
          <div className="py-8 text-center text-rose-700 dark:text-rose-300">{error ?? 'No data'}</div>
        </Card>
      </div>
    )
  }

  if (data.totalCount === 0) {
    return (
      <div className="space-y-5">
        <PageHeader
          title="Returns analytics"
          breadcrumbs={[{ label: 'Fulfillment', href: '/fulfillment' }, { label: 'Returns', href: '/fulfillment/returns' }, { label: 'Analytics' }]}
        />
        <EmptyState
          icon={BarChart3}
          title="No returns to analyze yet"
          description="Once returns start flowing in (manually-created or via channel webhooks), this page will surface rates, top reasons, and processing-time SLAs."
        />
      </div>
    )
  }

  return (
    <div className="space-y-5">
      <PageHeader
        title="Returns analytics"
        description={`Last ${data.windowDays} days · ${data.totalCount} total returns on file`}
        breadcrumbs={[{ label: 'Fulfillment', href: '/fulfillment' }, { label: 'Returns', href: '/fulfillment/returns' }, { label: 'Analytics' }]}
        actions={
          <Link
            href="/fulfillment/returns"
            className="h-8 px-3 text-base border border-slate-200 dark:border-slate-700 rounded-md hover:bg-slate-50 dark:hover:bg-slate-800 inline-flex items-center gap-1.5"
          >
            <ArrowLeft size={12} /> Back to workspace
          </Link>
        }
      />

      {/* KPI strip */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
        <Card>
          <div className="space-y-0.5">
            <div className="text-xs uppercase tracking-wider text-slate-500 dark:text-slate-400">Last 30 days</div>
            <div className="text-2xl font-semibold text-slate-900 dark:text-slate-100 tabular-nums">{data.last30}</div>
            {data.trendPct != null && (
              <div className={`text-xs tabular-nums inline-flex items-center gap-1 ${
                data.trendPct > 5 ? 'text-rose-600 dark:text-rose-400' : data.trendPct < -5 ? 'text-emerald-600 dark:text-emerald-400' : 'text-slate-500 dark:text-slate-400'
              }`}>
                {data.trendPct > 0 ? <TrendingUp size={11} /> : <TrendingDown size={11} />}
                {data.trendPct > 0 ? '+' : ''}{data.trendPct.toFixed(0)}% vs prior 30d
              </div>
            )}
          </div>
        </Card>
        <Card>
          <div className="space-y-0.5">
            <div className="text-xs uppercase tracking-wider text-slate-500 dark:text-slate-400">FBA / Warehouse</div>
            <div className="text-2xl font-semibold text-slate-900 dark:text-slate-100 tabular-nums">
              {data.fbaCount} <span className="text-base text-slate-400 dark:text-slate-500">/</span> {data.warehouseCount}
            </div>
            <div className="text-xs text-slate-500 dark:text-slate-400">FBA Amazon-managed · Warehouse operator-managed</div>
          </div>
        </Card>
        <Card>
          <div className="space-y-0.5">
            <div className="text-xs uppercase tracking-wider text-slate-500 dark:text-slate-400">Avg processing time</div>
            <div className="text-2xl font-semibold text-slate-900 dark:text-slate-100 tabular-nums inline-flex items-center gap-1.5">
              <Clock size={16} className="text-slate-400 dark:text-slate-500" />
              {data.avgProcessingDays != null
                ? `${data.avgProcessingDays.toFixed(1)}d`
                : '—'}
            </div>
            <div className="text-xs text-slate-500 dark:text-slate-400">{data.avgProcessingSampleSize} refunded sample</div>
          </div>
        </Card>
        <Card>
          <div className="space-y-1">
            <div className="text-xs uppercase tracking-wider text-slate-500 dark:text-slate-400">Top channel (count)</div>
            {data.byChannel.length > 0 ? (
              <>
                <div className="text-base font-semibold text-slate-900 dark:text-slate-100">{data.byChannel[0].channel}</div>
                <div className="text-xs text-slate-500 dark:text-slate-400 tabular-nums">
                  {data.byChannel[0].count} of {data.last30}
                </div>
              </>
            ) : (
              <div className="text-sm text-slate-400 dark:text-slate-500">—</div>
            )}
          </div>
        </Card>
      </div>

      {/* Daily trend chart */}
      <Card>
        <div className="space-y-3">
          <div className="text-sm font-semibold text-slate-700 dark:text-slate-300 inline-flex items-center gap-2">
            <TrendingUp size={14} /> Daily returns — last 30 days
          </div>
          <div className="h-56 w-full">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={trendData} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#e2e8f0" />
                <XAxis dataKey="date" tick={{ fontSize: 11 }} stroke="#94a3b8" />
                <YAxis allowDecimals={false} tick={{ fontSize: 11 }} stroke="#94a3b8" />
                <Tooltip
                  contentStyle={{ fontSize: 12, borderRadius: 6, borderColor: '#e2e8f0' }}
                  labelStyle={{ color: '#0f172a' }}
                />
                <Bar dataKey="count" fill="#2563eb" radius={[4, 4, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>
      </Card>

      {/* Two-column: rate table + top SKUs */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
        <Card>
          <div className="space-y-2">
            <div className="text-sm font-semibold text-slate-700 dark:text-slate-300">Return rate by channel</div>
            {data.returnRateByChannel.length === 0 ? (
              <div className="text-sm text-slate-500 dark:text-slate-400 py-4 text-center">No channel data yet.</div>
            ) : (
              <table className="w-full text-base">
                <thead className="border-b border-slate-200 dark:border-slate-700">
                  <tr>
                    <th className="px-2 py-1.5 text-left text-xs font-semibold uppercase text-slate-500 dark:text-slate-400">Channel</th>
                    <th className="px-2 py-1.5 text-right text-xs font-semibold uppercase text-slate-500 dark:text-slate-400">Returns</th>
                    <th className="px-2 py-1.5 text-right text-xs font-semibold uppercase text-slate-500 dark:text-slate-400">Orders</th>
                    <th className="px-2 py-1.5 text-right text-xs font-semibold uppercase text-slate-500 dark:text-slate-400">Rate</th>
                  </tr>
                </thead>
                <tbody>
                  {data.returnRateByChannel.map((row) => (
                    <tr key={row.channel} className="border-b border-slate-100 dark:border-slate-800">
                      <td className="px-2 py-1.5">
                        <span className={`inline-block text-xs font-semibold uppercase tracking-wider px-1.5 py-0.5 border rounded ${CHANNEL_TONE[row.channel] ?? 'bg-slate-50 dark:bg-slate-800 text-slate-600 dark:text-slate-400 border-slate-200 dark:border-slate-700'}`}>{row.channel}</span>
                      </td>
                      <td className="px-2 py-1.5 text-right tabular-nums text-slate-700 dark:text-slate-300">{row.returns}</td>
                      <td className="px-2 py-1.5 text-right tabular-nums text-slate-500 dark:text-slate-400">{row.orders}</td>
                      <td className="px-2 py-1.5 text-right tabular-nums">
                        {row.ratePct != null ? (
                          <span className={row.ratePct >= 10 ? 'text-rose-700 dark:text-rose-300 font-semibold' : row.ratePct >= 5 ? 'text-amber-700 dark:text-amber-300' : 'text-emerald-700 dark:text-emerald-300'}>
                            {row.ratePct.toFixed(1)}%
                          </span>
                        ) : (
                          <span className="text-slate-400 dark:text-slate-500">—</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </Card>

        <Card>
          <div className="space-y-2">
            <div className="text-sm font-semibold text-slate-700 dark:text-slate-300 inline-flex items-center gap-2">
              <Box size={14} /> Top returned SKUs
            </div>
            {data.topReturnSkus.length === 0 ? (
              <div className="text-sm text-slate-500 dark:text-slate-400 py-4 text-center">No SKU data yet.</div>
            ) : (
              <table className="w-full text-base">
                <thead className="border-b border-slate-200 dark:border-slate-700">
                  <tr>
                    <th className="px-2 py-1.5 text-left text-xs font-semibold uppercase text-slate-500 dark:text-slate-400">SKU</th>
                    <th className="px-2 py-1.5 text-right text-xs font-semibold uppercase text-slate-500 dark:text-slate-400">Returns</th>
                    <th className="px-2 py-1.5 text-right text-xs font-semibold uppercase text-slate-500 dark:text-slate-400">Units</th>
                  </tr>
                </thead>
                <tbody>
                  {data.topReturnSkus.map((row) => (
                    <tr key={row.sku} className="border-b border-slate-100 dark:border-slate-800">
                      <td className="px-2 py-1.5 font-mono text-slate-700 dark:text-slate-300 truncate max-w-[200px]">{row.sku}</td>
                      <td className="px-2 py-1.5 text-right tabular-nums">{row.returnCount}</td>
                      <td className="px-2 py-1.5 text-right tabular-nums text-slate-500 dark:text-slate-400">{row.unitsReturned}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </Card>
      </div>

      {/* R7.2 — High-return-risk SKUs */}
      <Card>
        <div className="space-y-2">
          <div className="text-sm font-semibold text-slate-700 dark:text-slate-300 inline-flex items-center gap-2">
            <AlertTriangle size={14} className="text-rose-600 dark:text-rose-400" /> High-return-risk SKUs
            {risk && (
              <span className="text-xs font-normal text-slate-500 dark:text-slate-400 ml-1">
                ({risk.summary.flaggedCount} flagged across {risk.summary.bucketsAnalyzed} product types · {risk.summary.skusScored} scored · last {risk.windowDays}d)
              </span>
            )}
          </div>
          {!risk ? (
            <div className="text-sm text-slate-500 dark:text-slate-400 py-4 text-center">Loading risk scores…</div>
          ) : risk.flagged.length === 0 ? (
            <div className="text-sm text-slate-500 dark:text-slate-400 py-4 text-center">
              No SKUs flagged. (Need ≥3 returns AND a productType bucket of ≥3 SKUs to compute a meaningful z-score.)
            </div>
          ) : (
            <table className="w-full text-base">
              <thead className="border-b border-slate-200 dark:border-slate-700">
                <tr>
                  <th className="px-2 py-1.5 text-left text-xs font-semibold uppercase text-slate-500 dark:text-slate-400">SKU</th>
                  <th className="px-2 py-1.5 text-left text-xs font-semibold uppercase text-slate-500 dark:text-slate-400">Type</th>
                  <th className="px-2 py-1.5 text-right text-xs font-semibold uppercase text-slate-500 dark:text-slate-400">Returns / Orders</th>
                  <th className="px-2 py-1.5 text-right text-xs font-semibold uppercase text-slate-500 dark:text-slate-400">Rate</th>
                  <th className="px-2 py-1.5 text-right text-xs font-semibold uppercase text-slate-500 dark:text-slate-400" title="Standard deviations above the productType mean">σ</th>
                </tr>
              </thead>
              <tbody>
                {risk.flagged.map((row) => (
                  <tr key={row.sku} className="border-b border-slate-100 dark:border-slate-800">
                    <td className="px-2 py-1.5">
                      <div className="font-mono text-slate-900 dark:text-slate-100 truncate max-w-[160px]">{row.sku}</div>
                      {row.productName && (
                        <div className="text-xs text-slate-500 dark:text-slate-400 truncate max-w-[200px]">{row.productName}</div>
                      )}
                    </td>
                    <td className="px-2 py-1.5 text-xs text-slate-600 dark:text-slate-400 truncate max-w-[120px]">
                      {row.productType ?? '—'}
                    </td>
                    <td className="px-2 py-1.5 text-right tabular-nums text-slate-700 dark:text-slate-300">
                      {row.returnCount} / {row.orderCount}
                    </td>
                    <td className="px-2 py-1.5 text-right tabular-nums">
                      <span className="text-rose-700 dark:text-rose-300 font-semibold">{row.ratePct.toFixed(1)}%</span>
                      <div className="text-xs text-slate-500 dark:text-slate-400">vs {row.bucketMeanPct.toFixed(1)}% mean</div>
                    </td>
                    <td className="px-2 py-1.5 text-right tabular-nums text-rose-700 dark:text-rose-300 font-semibold">
                      +{row.z.toFixed(1)}σ
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </Card>

      {/* Top reasons */}
      <Card>
        <div className="space-y-2">
          <div className="text-sm font-semibold text-slate-700 dark:text-slate-300 inline-flex items-center gap-2">
            <Tag size={14} /> Top return reasons (last 30 days)
          </div>
          {data.topReasons.length === 0 ? (
            <div className="text-sm text-slate-500 dark:text-slate-400 py-4 text-center">No reasons reported yet.</div>
          ) : (
            <ol className="space-y-1.5 text-base">
              {data.topReasons.map((r, idx) => (
                <li key={r.reason} className="flex items-center gap-3">
                  <span className="text-xs text-slate-400 dark:text-slate-500 tabular-nums w-5">{idx + 1}.</span>
                  <span className="flex-1 text-slate-800 dark:text-slate-200 truncate" title={r.reason}>{r.reason}</span>
                  <span className="tabular-nums text-slate-600 dark:text-slate-400">{r.count}</span>
                </li>
              ))}
            </ol>
          )}
        </div>
      </Card>
    </div>
  )
}
