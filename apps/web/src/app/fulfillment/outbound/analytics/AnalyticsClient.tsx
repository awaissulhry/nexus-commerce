'use client'

// O.31 — Outbound analytics dashboard. Reads
// /api/fulfillment/outbound/analytics and renders KPI cards + trend
// + carrier breakdown.

import { useCallback, useEffect, useState } from 'react'
import {
  Truck, Clock, AlertTriangle, TrendingUp, RefreshCw, DollarSign, Lightbulb, Users,
} from 'lucide-react'
import PageHeader from '@/components/layout/PageHeader'
import { Card } from '@/components/ui/Card'
import { Badge } from '@/components/ui/Badge'
import { useTranslations } from '@/lib/i18n/use-translations'
import { getBackendUrl } from '@/lib/backend-url'

interface Analytics {
  windowDays: number
  totals: { shipped: number; totalCostCents: number; avgCostCents: number | null }
  timeToShipHours: { median: number | null; p95: number | null; p99: number | null; count: number }
  sla: { onTime: number; late: number; lateRate: number | null }
  byCarrier: Array<{
    carrierCode: string
    count: number
    totalCostCents: number
    avgCostCents: number | null
    lateCount: number
    lateRate: number | null
  }>
  byChannel: Record<string, number>
  byChannelSLA?: Array<{
    channel: string
    count: number
    lateCount: number
    onTimeCount: number
    lateRate: number | null
    avgTimeToShipHours: number | null
  }>
  byMarketplaceSLA?: Array<{
    channel: string
    marketplace: string | null
    count: number
    lateCount: number
    onTimeCount: number
    lateRate: number | null
  }>
  byPicker: Array<{
    operator: string
    count: number
    medianCycleMinutes: number | null
    samples: number
  }>
  trend: Array<{ date: string; ships: number }>
  insights: Array<{
    kind: 'cost' | 'reliability'
    severity: 'info' | 'warning'
    message: string
    carrierCode?: string
    savingsCentsPerMonth?: number
  }>
}

const WINDOWS = [7, 30, 90] as const

function formatHours(h: number | null): string {
  if (h == null) return '—'
  if (h < 1) return `${Math.round(h * 60)}m`
  if (h < 48) return `${h.toFixed(1)}h`
  return `${(h / 24).toFixed(1)}d`
}

function formatPct(v: number | null): string {
  if (v == null) return '—'
  return `${(v * 100).toFixed(1)}%`
}

function formatEur(cents: number | null): string {
  if (cents == null) return '—'
  return `€${(cents / 100).toFixed(2)}`
}

export default function AnalyticsClient() {
  const { t } = useTranslations()
  const [data, setData] = useState<Analytics | null>(null)
  const [loading, setLoading] = useState(true)
  const [days, setDays] = useState<number>(30)

  const fetchData = useCallback(async () => {
    setLoading(true)
    try {
      const res = await fetch(
        `${getBackendUrl()}/api/fulfillment/outbound/analytics?days=${days}`,
        { cache: 'no-store' },
      )
      if (res.ok) setData(await res.json())
    } finally {
      setLoading(false)
    }
  }, [days])

  useEffect(() => { fetchData() }, [fetchData])

  // Trend chart: simple SVG sparkline. Bounded width; height fixed.
  const renderTrend = () => {
    if (!data || data.trend.length === 0) return null
    const w = 800
    const h = 80
    const max = Math.max(1, ...data.trend.map((d) => d.ships))
    const step = data.trend.length > 1 ? w / (data.trend.length - 1) : w
    const points = data.trend
      .map((d, i) => `${i * step},${h - (d.ships / max) * h}`)
      .join(' ')
    return (
      <svg viewBox={`0 0 ${w} ${h}`} className="w-full h-20" preserveAspectRatio="none">
        <polyline
          points={points}
          fill="none"
          stroke="#2563eb"
          strokeWidth={2}
          vectorEffect="non-scaling-stroke"
        />
        {data.trend.map((d, i) => (
          <circle
            key={d.date}
            cx={i * step}
            cy={h - (d.ships / max) * h}
            r={1.5}
            fill="#2563eb"
          />
        ))}
      </svg>
    )
  }

  const totalChannelShips = data
    ? Object.values(data.byChannel).reduce((n, v) => n + v, 0)
    : 0

  return (
    <div className="space-y-5">
      <PageHeader
        title={t('analytics.title')}
        description={t('analytics.description')}
        breadcrumbs={[
          { label: t('nav.fulfillment'), href: '/fulfillment' },
          { label: t('nav.outbound'), href: '/fulfillment/outbound' },
          { label: t('analytics.title') },
        ]}
        actions={
          <div className="flex items-center gap-2">
            <div className="flex items-center gap-1 border border-slate-200 rounded-md bg-white p-0.5">
              {WINDOWS.map((d) => (
                <button
                  key={d}
                  onClick={() => setDays(d)}
                  className={`h-7 px-3 text-base rounded transition-colors ${
                    days === d ? 'bg-slate-900 text-white' : 'text-slate-700 hover:bg-slate-50'
                  }`}
                >
                  {t('analytics.days', { n: d })}
                </button>
              ))}
            </div>
            <button
              onClick={fetchData}
              className="h-8 px-3 text-base border border-slate-200 rounded-md hover:bg-slate-50 inline-flex items-center gap-1.5"
            >
              <RefreshCw size={12} /> {t('common.refresh')}
            </button>
          </div>
        }
      />

      {loading && !data ? (
        <Card><div className="text-md text-slate-500 py-8 text-center">{t('common.loading')}</div></Card>
      ) : !data ? (
        <Card><div className="text-md text-slate-500 py-8 text-center">{t('common.error')}</div></Card>
      ) : (
        <>
          {/* KPI cards */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <Kpi
              icon={Truck}
              tone="bg-blue-50 text-blue-600"
              label={t('analytics.kpi.shipped')}
              value={String(data.totals.shipped)}
              hint={t('analytics.kpi.windowHint', { n: data.windowDays })}
            />
            <Kpi
              icon={Clock}
              tone="bg-emerald-50 text-emerald-600"
              label={t('analytics.kpi.medianTtS')}
              value={formatHours(data.timeToShipHours.median)}
              hint={t('analytics.kpi.p95Hint', { p95: formatHours(data.timeToShipHours.p95) })}
            />
            <Kpi
              icon={AlertTriangle}
              tone={
                data.sla.lateRate != null && data.sla.lateRate > 0.04
                  ? 'bg-rose-50 text-rose-600'
                  : 'bg-emerald-50 text-emerald-600'
              }
              label={t('analytics.kpi.lateRate')}
              value={formatPct(data.sla.lateRate)}
              hint={t('analytics.kpi.lateHint', { late: data.sla.late, total: data.sla.late + data.sla.onTime })}
            />
            <Kpi
              icon={DollarSign}
              tone="bg-slate-50 text-slate-700"
              label={t('analytics.kpi.avgCost')}
              value={formatEur(data.totals.avgCostCents)}
              hint={t('analytics.kpi.totalCostHint', { total: formatEur(data.totals.totalCostCents) })}
            />
          </div>

          {/* O.38: Insights / recommendations */}
          {data.insights && data.insights.length > 0 && (
            <Card>
              <div className="space-y-3">
                <div className="flex items-center gap-2 text-sm font-semibold text-slate-700 uppercase tracking-wider">
                  <Lightbulb size={12} /> {t('analytics.insights.title')}
                  <span className="ml-auto text-xs text-slate-500 font-normal normal-case tracking-normal">
                    {t('analytics.insights.subtitle')}
                  </span>
                </div>
                <div className="space-y-2">
                  {data.insights.map((ins, i) => (
                    <div
                      key={i}
                      className={`flex items-start gap-3 px-3 py-2.5 rounded border ${
                        ins.severity === 'warning'
                          ? 'bg-amber-50 border-amber-200 text-amber-900'
                          : 'bg-blue-50 border-blue-200 text-blue-900'
                      }`}
                    >
                      {ins.kind === 'cost' ? (
                        <DollarSign size={14} className="flex-shrink-0 mt-0.5" />
                      ) : (
                        <AlertTriangle size={14} className="flex-shrink-0 mt-0.5" />
                      )}
                      <div className="flex-1 text-md">{ins.message}</div>
                    </div>
                  ))}
                </div>
              </div>
            </Card>
          )}

          {/* Trend */}
          <Card>
            <div className="space-y-3">
              <div className="flex items-center gap-2 text-sm font-semibold text-slate-700 uppercase tracking-wider">
                <TrendingUp size={12} /> {t('analytics.trend.title')}
                <span className="ml-auto text-xs text-slate-500 font-normal normal-case tracking-normal">
                  {t('analytics.trend.subtitle', { n: data.windowDays })}
                </span>
              </div>
              {data.trend.some((d) => d.ships > 0) ? (
                renderTrend()
              ) : (
                <div className="text-md text-slate-400 py-8 text-center">{t('analytics.empty')}</div>
              )}
            </div>
          </Card>

          {/* Per-carrier breakdown */}
          <Card noPadding>
            <table className="w-full text-md">
              <thead className="border-b border-slate-200 bg-slate-50">
                <tr>
                  <th className="px-3 py-2 text-left text-sm font-semibold uppercase tracking-wider text-slate-700">
                    {t('analytics.col.carrier')}
                  </th>
                  <th className="px-3 py-2 text-right text-sm font-semibold uppercase tracking-wider text-slate-700">
                    {t('analytics.col.ships')}
                  </th>
                  <th className="px-3 py-2 text-right text-sm font-semibold uppercase tracking-wider text-slate-700">
                    {t('analytics.col.avgCost')}
                  </th>
                  <th className="px-3 py-2 text-right text-sm font-semibold uppercase tracking-wider text-slate-700">
                    {t('analytics.col.lateRate')}
                  </th>
                </tr>
              </thead>
              <tbody>
                {data.byCarrier.length === 0 ? (
                  <tr>
                    <td colSpan={4} className="px-3 py-8 text-center text-md text-slate-400">
                      {t('analytics.empty')}
                    </td>
                  </tr>
                ) : (
                  data.byCarrier.map((c) => (
                    <tr key={c.carrierCode} className="border-b border-slate-100">
                      <td className="px-3 py-2 text-base text-slate-900 font-medium">
                        {c.carrierCode}
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums text-base text-slate-700">{c.count}</td>
                      <td className="px-3 py-2 text-right tabular-nums text-base text-slate-700">
                        {formatEur(c.avgCostCents)}
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums text-base">
                        {c.lateRate != null && c.lateRate > 0.04 ? (
                          <Badge variant="danger" size="sm">{formatPct(c.lateRate)}</Badge>
                        ) : (
                          <span className="text-slate-700">{formatPct(c.lateRate)}</span>
                        )}
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </Card>

          {/* O.56: Picker performance leaderboard. Renders only when
              packedBy data exists — fresh installs without operator
              attribution skip the section. */}
          {data.byPicker && data.byPicker.length > 0 && (
            <Card noPadding>
              <table className="w-full text-md">
                <thead className="border-b border-slate-200 bg-slate-50">
                  <tr>
                    <th className="px-3 py-2 text-left text-sm font-semibold uppercase tracking-wider text-slate-700">
                      <span className="inline-flex items-center gap-1.5">
                        <Users size={12} /> {t('analytics.picker.operator')}
                      </span>
                    </th>
                    <th className="px-3 py-2 text-right text-sm font-semibold uppercase tracking-wider text-slate-700">
                      {t('analytics.picker.shipments')}
                    </th>
                    <th className="px-3 py-2 text-right text-sm font-semibold uppercase tracking-wider text-slate-700">
                      {t('analytics.picker.medianCycle')}
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {data.byPicker.map((p, idx) => (
                    <tr key={p.operator} className="border-b border-slate-100">
                      <td className="px-3 py-2 text-base text-slate-900 font-medium">
                        {idx === 0 && <span className="mr-1 text-amber-500">★</span>}
                        {p.operator}
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums text-base text-slate-700">{p.count}</td>
                      <td className="px-3 py-2 text-right tabular-nums text-base text-slate-700">
                        {p.medianCycleMinutes == null
                          ? '—'
                          : p.medianCycleMinutes < 60
                          ? `${Math.round(p.medianCycleMinutes)}m`
                          : `${(p.medianCycleMinutes / 60).toFixed(1)}h`}
                        {p.samples > 0 && (
                          <span className="ml-1 text-xs text-slate-400">({p.samples})</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Card>
          )}

          {/* Channel breakdown */}
          {totalChannelShips > 0 && (
            <Card>
              <div className="space-y-2">
                <div className="text-sm font-semibold text-slate-700 uppercase tracking-wider">
                  {t('analytics.byChannel')}
                </div>
                <div className="flex items-center gap-2 flex-wrap">
                  {Object.entries(data.byChannel)
                    .sort((a, b) => b[1] - a[1])
                    .map(([ch, count]) => {
                      const pct = (count / totalChannelShips) * 100
                      return (
                        <div
                          key={ch}
                          className="inline-flex items-center gap-2 px-3 py-1.5 bg-slate-50 border border-slate-200 rounded"
                        >
                          <span className="text-base font-medium text-slate-900">{ch}</span>
                          <span className="text-sm tabular-nums text-slate-600">
                            {count} · {pct.toFixed(0)}%
                          </span>
                        </div>
                      )
                    })}
                </div>
              </div>
            </Card>
          )}

          {/* O.72: SLA per channel + per marketplace. Splits the
              global late-rate KPI into the dimensions operators
              actually care about. Amazon-IT-Prime is much stricter
              than eBay or Shopify; an aggregate "5% late" can hide a
              marketplace-specific crisis. Highlights any row whose
              late rate is materially worse than the global. */}
          {data.byChannelSLA && data.byChannelSLA.length > 0 && (
            <Card>
              <div className="space-y-2">
                <div className="text-sm font-semibold text-slate-700 uppercase tracking-wider">
                  {t('analytics.slaByChannel.title')}
                </div>
                <table className="w-full text-base">
                  <thead className="border-b border-slate-200">
                    <tr>
                      <th className="px-3 py-1.5 text-left text-sm font-semibold text-slate-700">
                        {t('analytics.slaByChannel.col.channel')}
                      </th>
                      <th className="px-3 py-1.5 text-right text-sm font-semibold text-slate-700">
                        {t('analytics.slaByChannel.col.shipped')}
                      </th>
                      <th className="px-3 py-1.5 text-right text-sm font-semibold text-slate-700">
                        {t('analytics.slaByChannel.col.late')}
                      </th>
                      <th className="px-3 py-1.5 text-right text-sm font-semibold text-slate-700">
                        {t('analytics.slaByChannel.col.lateRate')}
                      </th>
                      <th className="px-3 py-1.5 text-right text-sm font-semibold text-slate-700">
                        {t('analytics.slaByChannel.col.avgTtS')}
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.byChannelSLA.map((row) => {
                      const tone =
                        row.lateRate != null && row.lateRate > 0.1
                          ? 'text-rose-700'
                          : row.lateRate != null && row.lateRate > 0.05
                          ? 'text-amber-700'
                          : 'text-slate-700'
                      return (
                        <tr key={row.channel} className="border-b border-slate-100 last:border-0">
                          <td className="px-3 py-1.5 font-medium text-slate-900">{row.channel}</td>
                          <td className="px-3 py-1.5 text-right tabular-nums text-slate-700">{row.count}</td>
                          <td className={`px-3 py-1.5 text-right tabular-nums ${tone}`}>{row.lateCount}</td>
                          <td className={`px-3 py-1.5 text-right tabular-nums font-medium ${tone}`}>
                            {formatPct(row.lateRate)}
                          </td>
                          <td className="px-3 py-1.5 text-right tabular-nums text-slate-700">
                            {formatHours(row.avgTimeToShipHours)}
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
            </Card>
          )}

          {data.byMarketplaceSLA && data.byMarketplaceSLA.filter((r) => r.marketplace).length > 1 && (
            <Card>
              <div className="space-y-2">
                <div className="text-sm font-semibold text-slate-700 uppercase tracking-wider">
                  {t('analytics.slaByMarketplace.title')}
                </div>
                <div className="text-xs text-slate-500">{t('analytics.slaByMarketplace.subtitle')}</div>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
                  {data.byMarketplaceSLA
                    .filter((r) => r.marketplace)
                    .map((row) => {
                      const key = `${row.channel}:${row.marketplace}`
                      const tone =
                        row.lateRate != null && row.lateRate > 0.1
                          ? 'border-rose-200 bg-rose-50'
                          : row.lateRate != null && row.lateRate > 0.05
                          ? 'border-amber-200 bg-amber-50'
                          : 'border-slate-200 bg-slate-50'
                      return (
                        <div
                          key={key}
                          className={`flex items-center justify-between px-3 py-1.5 border rounded ${tone}`}
                        >
                          <div className="font-medium text-slate-900 text-base">
                            {row.channel}
                            <span className="text-slate-500 mx-1">·</span>
                            {row.marketplace}
                          </div>
                          <div className="flex items-center gap-2 text-sm tabular-nums">
                            <span className="text-slate-600">{row.count}</span>
                            <span className="text-slate-400">·</span>
                            <span className="font-medium text-slate-900">{formatPct(row.lateRate)}</span>
                          </div>
                        </div>
                      )
                    })}
                </div>
              </div>
            </Card>
          )}
        </>
      )}
    </div>
  )
}

function Kpi({
  icon: Icon,
  tone,
  label,
  value,
  hint,
}: {
  icon: typeof Truck
  tone: string
  label: string
  value: string
  hint: string
}) {
  return (
    <Card>
      <div className="flex items-start gap-3">
        <div className={`w-10 h-10 rounded-md inline-flex items-center justify-center ${tone}`}>
          <Icon size={18} />
        </div>
        <div className="flex-1 min-w-0">
          <div className="text-xs uppercase tracking-wider text-slate-500">{label}</div>
          <div className="text-2xl font-semibold text-slate-900 tabular-nums">{value}</div>
          <div className="text-xs text-slate-500 mt-0.5">{hint}</div>
        </div>
      </div>
    </Card>
  )
}
