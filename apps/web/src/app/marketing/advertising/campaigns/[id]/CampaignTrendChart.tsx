'use client'

/**
 * CD.1 — Campaign-scoped performance trend chart (presentational).
 *
 * Renders a dual-Y-axis recharts line chart from the campaign-scoped
 * /advertising/trends rows: counts on the left axis (impressions / clicks /
 * orders), EUR on the right axis (spend / sales), plus toggleable ratio lines
 * (ACOS % / ROAS× / CTR %). The window selector is controlled by the parent
 * (the cockpit owns the single compare-enabled fetch so the chart + KPI delta
 * tiles stay in sync). TACOS is intentionally absent — it is account-level.
 */

import { useState } from 'react'
import { LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid, Legend } from 'recharts'

export interface TrendRow {
  date: string
  impressions: number
  clicks: number
  orders: number
  adSpendCents: number
  adSalesCents: number
  acos: number | null
  ctr: number | null
}

type MetricKey = 'spend' | 'sales' | 'clicks' | 'impressions' | 'orders' | 'acos' | 'roas' | 'ctr'

const METRICS: Array<{ key: MetricKey; label: string; color: string; axis: 'l' | 'r'; unit: 'eur' | 'count' | 'pct' | 'x' }> = [
  { key: 'spend',       label: 'Spend',       color: '#f59e0b', axis: 'r', unit: 'eur' },
  { key: 'sales',       label: 'Sales',       color: '#a855f7', axis: 'r', unit: 'eur' },
  { key: 'clicks',      label: 'Clicks',      color: '#6366f1', axis: 'l', unit: 'count' },
  { key: 'impressions', label: 'Impressions', color: '#94a3b8', axis: 'l', unit: 'count' },
  { key: 'orders',      label: 'Orders',      color: '#10b981', axis: 'l', unit: 'count' },
  { key: 'acos',        label: 'ACOS %',      color: '#ef4444', axis: 'r', unit: 'pct' },
  { key: 'roas',        label: 'ROAS ×',      color: '#0ea5e9', axis: 'r', unit: 'x' },
  { key: 'ctr',         label: 'CTR %',       color: '#14b8a6', axis: 'r', unit: 'pct' },
]

export const TREND_WINDOWS = [7, 14, 30, 60, 90] as const

const fmt = (unit: string, v: number | null) => {
  if (v == null) return '—'
  if (unit === 'eur') return new Intl.NumberFormat('en-IE', { style: 'currency', currency: 'EUR', maximumFractionDigits: 0 }).format(v)
  if (unit === 'pct') return `${v.toFixed(1)}%`
  if (unit === 'x') return `${v.toFixed(2)}×`
  return new Intl.NumberFormat('en-US').format(Math.round(v))
}

export function CampaignTrendChart({
  rows, windowDays, onWindowChange, loading, hideWindow = false,
}: {
  rows: TrendRow[] | null
  windowDays: number
  onWindowChange: (w: number) => void
  loading: boolean
  // DR.2 — hide the built-in 7/14/30/60/90 buttons when an external
  // DateRangePicker is the single source of truth for the window.
  hideWindow?: boolean
}) {
  const [active, setActive] = useState<Set<MetricKey>>(() => new Set<MetricKey>(['spend', 'sales', 'clicks']))

  const data = (rows ?? []).map((p) => {
    const spend = p.adSpendCents / 100
    const sales = p.adSalesCents / 100
    return {
      date: p.date.slice(5), // MM-DD
      impressions: p.impressions,
      clicks: p.clicks,
      orders: p.orders,
      spend, sales,
      acos: p.acos,
      roas: spend > 0 ? Math.round((sales / spend) * 100) / 100 : null,
      ctr: p.ctr,
    }
  })

  const toggle = (k: MetricKey) => setActive((s) => {
    const next = new Set(s)
    if (next.has(k)) next.delete(k); else next.add(k)
    return next
  })

  const hasData = data.some((d) => d.impressions || d.clicks || d.spend || d.sales)

  return (
    <div className="mb-4 rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-950 p-3">
      <div className="flex flex-wrap items-center justify-between gap-2 mb-2">
        <div className="flex flex-wrap items-center gap-1.5">
          {METRICS.map((m) => (
            <button key={m.key} onClick={() => toggle(m.key)}
              className={`inline-flex items-center gap-1 px-2 py-0.5 text-xs rounded-full border transition ${active.has(m.key) ? 'border-slate-300 dark:border-slate-600 bg-slate-50 dark:bg-slate-800 text-slate-700 dark:text-slate-200' : 'border-transparent text-slate-400 hover:text-slate-600'}`}>
              <span className="inline-block h-2 w-2 rounded-full" style={{ background: active.has(m.key) ? m.color : '#cbd5e1' }} />
              {m.label}
            </button>
          ))}
        </div>
        <div className="inline-flex items-center gap-1" hidden={hideWindow}>
          {TREND_WINDOWS.map((w) => (
            <button key={w} onClick={() => onWindowChange(w)}
              className={`px-2 py-0.5 text-xs rounded border ${windowDays === w ? 'border-blue-500 text-blue-700 dark:text-blue-300 bg-blue-50 dark:bg-blue-950/40' : 'border-slate-200 dark:border-slate-700 text-slate-500 hover:text-slate-700'}`}>{w}d</button>
          ))}
        </div>
      </div>
      <div style={{ width: '100%', height: 240 }}>
        {rows == null || loading ? (
          <div className="h-full grid place-items-center text-sm text-slate-400">Loading…</div>
        ) : !hasData ? (
          <div className="h-full grid place-items-center text-sm text-slate-400">No performance data in this window yet.</div>
        ) : (
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={data} margin={{ top: 4, right: 8, bottom: 0, left: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" className="dark:opacity-20" />
              <XAxis dataKey="date" tick={{ fontSize: 10 }} minTickGap={16} />
              <YAxis yAxisId="l" tick={{ fontSize: 10 }} width={44} />
              <YAxis yAxisId="r" orientation="right" tick={{ fontSize: 10 }} width={48} />
              <Tooltip
                contentStyle={{ fontSize: 12, borderRadius: 8 }}
                formatter={(value, name) => {
                  const m = METRICS.find((x) => x.label === name)
                  return [fmt(m?.unit ?? 'count', typeof value === 'number' ? value : Number(value)), String(name)]
                }}
              />
              <Legend wrapperStyle={{ fontSize: 11 }} />
              {METRICS.filter((m) => active.has(m.key)).map((m) => (
                <Line key={m.key} yAxisId={m.axis} type="monotone" dataKey={m.key} name={m.label} stroke={m.color} dot={false} strokeWidth={1.75} connectNulls />
              ))}
            </LineChart>
          </ResponsiveContainer>
        )}
      </div>
    </div>
  )
}
