'use client'

/**
 * Amazon-faithful account Performance panel (Phase C): a horizontally
 * scrollable strip of KPI tiles (each toggles a line onto the chart, max 3)
 * over a multi-metric time-series chart. Every metric is its own auto-scaled
 * axis so line shapes stay comparable across wildly different units (Amazon
 * does the same). Fed by GET /advertising/trends (daily rows + summary +
 * previous-period for the ▲/▼ deltas). Filtered by the active ad-type tab
 * (adProduct) and the shared date range (days).
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import { CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import { getBackendUrl } from '@/lib/backend-url'

type Kind = 'eur' | 'int' | 'pct' | 'x2'
interface Metric { key: string; label: string; kind: Kind; color: string; goodLow?: boolean }

// 14 metrics — the chart's "tens of metrics" picker (tile strip).
const METRICS: Metric[] = [
  { key: 'impressions', label: 'Impressions', kind: 'int', color: '#6366f1' },
  { key: 'clicks', label: 'Clicks', kind: 'int', color: '#0ea5e9' },
  { key: 'ctr', label: 'CTR', kind: 'pct', color: '#06b6d4' },
  { key: 'spend', label: 'Spend', kind: 'eur', color: '#ff9900' },
  { key: 'cpc', label: 'CPC', kind: 'eur', color: '#d97706', goodLow: true },
  { key: 'cpm', label: 'CPM', kind: 'eur', color: '#b45309', goodLow: true },
  { key: 'orders', label: 'Orders', kind: 'int', color: '#8b5cf6' },
  { key: 'cvr', label: 'Conversion rate', kind: 'pct', color: '#d946ef' },
  { key: 'sales', label: 'Sales', kind: 'eur', color: '#067d62' },
  { key: 'aov', label: 'Avg. order value', kind: 'eur', color: '#0d9488' },
  { key: 'acos', label: 'ACOS', kind: 'pct', color: '#e11d48', goodLow: true },
  { key: 'roas', label: 'ROAS', kind: 'x2', color: '#10b981' },
  { key: 'tacos', label: 'TACOS', kind: 'pct', color: '#f43f5e', goodLow: true },
  { key: 'totalRevenue', label: 'Total sales', kind: 'eur', color: '#475569' },
]
const META = Object.fromEntries(METRICS.map((m) => [m.key, m])) as Record<string, Metric>

interface TrendRow { date: string; impressions: number; clicks: number; orders: number; adSpendCents: number; adSalesCents: number; totalRevenueCents: number; acos: number | null; tacos: number | null; ctr: number | null }
interface Summary { impressions: number; clicks: number; orders: number; spendCents: number; salesCents: number; acos: number | null; roas: number | null; ctr: number | null }

const ADP: Record<string, string> = { SP: 'SPONSORED_PRODUCTS', SB: 'SPONSORED_BRANDS', SD: 'SPONSORED_DISPLAY' }

const eurFull = (v: number) => new Intl.NumberFormat('en-IE', { style: 'currency', currency: 'EUR', maximumFractionDigits: v < 100 ? 2 : 0 }).format(v)
const intFull = (v: number) => new Intl.NumberFormat('en-US').format(Math.round(v))
const fmtVal = (m: Metric, v: number | null): string => {
  if (v == null || !Number.isFinite(v)) return '—'
  if (m.kind === 'eur') return eurFull(v)
  if (m.kind === 'pct') return `${v.toFixed(2)}%`
  if (m.kind === 'x2') return v.toFixed(2)
  return intFull(v)
}
const fmtAxis = (m: Metric, v: number): string => {
  if (m.kind === 'eur') return v >= 1000 ? `€${(v / 1000).toFixed(1)}k` : `€${v.toFixed(v < 10 ? 1 : 0)}`
  if (m.kind === 'pct') return `${v.toFixed(0)}%`
  if (m.kind === 'x2') return v.toFixed(1)
  return v >= 1000 ? `${(v / 1000).toFixed(1)}k` : String(Math.round(v))
}

export function PerformancePanel({ adProduct, days, marketplace }: { adProduct: string; days: number; marketplace?: string }) {
  const [rows, setRows] = useState<TrendRow[]>([])
  const [summary, setSummary] = useState<Summary | null>(null)
  const [previous, setPrevious] = useState<Summary | null>(null)
  const [loading, setLoading] = useState(true)
  const [active, setActive] = useState<string[]>(['spend', 'sales', 'acos'])

  useEffect(() => {
    let off = false
    setLoading(true)
    const qs = new URLSearchParams({ windowDays: String(days), compare: 'true' })
    if (adProduct && ADP[adProduct]) qs.set('adProduct', ADP[adProduct])
    if (marketplace) qs.set('marketplace', marketplace)
    fetch(`${getBackendUrl()}/api/advertising/trends?${qs}`, { cache: 'no-store' })
      .then((r) => r.json())
      .then((d) => { if (off) return; setRows(d.rows ?? []); setSummary(d.summary ?? null); setPrevious(d.previous ?? null) })
      .catch(() => { if (off) return; setRows([]); setSummary(null); setPrevious(null) })
      .finally(() => { if (!off) setLoading(false) })
    return () => { off = true }
  }, [adProduct, days, marketplace])

  // per-day chart points: derive every metric from the raw daily rows
  const points = useMemo(() => rows.map((r) => {
    const spend = r.adSpendCents / 100, sales = r.adSalesCents / 100, rev = r.totalRevenueCents / 100
    return {
      date: r.date,
      impressions: r.impressions, clicks: r.clicks, orders: r.orders,
      ctr: r.ctr, spend, sales, totalRevenue: rev,
      cpc: r.clicks > 0 ? spend / r.clicks : null,
      cpm: r.impressions > 0 ? (spend / r.impressions) * 1000 : null,
      cvr: r.clicks > 0 ? (r.orders / r.clicks) * 100 : null,
      aov: r.orders > 0 ? sales / r.orders : null,
      acos: r.acos, tacos: r.tacos,
      roas: spend > 0 ? sales / spend : null,
    }
  }), [rows])

  // period totals for the KPI tiles (+ previous period for deltas)
  const totals = useCallback((s: Summary | null, withRevenue: boolean): Record<string, number | null> => {
    if (!s) return {}
    const spend = s.spendCents / 100, sales = s.salesCents / 100
    const rev = withRevenue ? rows.reduce((a, r) => a + r.totalRevenueCents, 0) / 100 : null
    return {
      impressions: s.impressions, clicks: s.clicks, orders: s.orders,
      ctr: s.ctr, spend, sales, roas: s.roas, acos: s.acos,
      cpc: s.clicks > 0 ? spend / s.clicks : null,
      cpm: s.impressions > 0 ? (spend / s.impressions) * 1000 : null,
      cvr: s.clicks > 0 ? (s.orders / s.clicks) * 100 : null,
      aov: s.orders > 0 ? sales / s.orders : null,
      totalRevenue: rev,
      tacos: rev && rev > 0 ? (spend / rev) * 100 : null,
    }
  }, [rows])
  const cur = useMemo(() => totals(summary, true), [totals, summary])
  const prev = useMemo(() => totals(previous, false), [totals, previous])

  const toggle = (key: string) => setActive((a) => a.includes(key) ? a.filter((k) => k !== key) : a.length >= 3 ? [...a.slice(1), key] : [...a, key])

  const activeMetrics = active.map((k) => META[k]).filter(Boolean)

  if (loading) return <div className="az-perf"><div className="az-perf-skel" /></div>
  const hasData = points.some((p) => p.impressions > 0 || p.clicks > 0 || p.spend > 0)

  return (
    <div className="az-perf">
      <div className="az-perf-head">
        <span className="t">Performance</span>
        <span className="hint">Click a metric to chart it · up to 3 · last {days} days</span>
      </div>

      <div className="az-kpis">
        {METRICS.map((m) => {
          const v = cur[m.key] ?? null
          const pv = prev[m.key] ?? null
          let delta: number | null = null
          if (v != null && pv != null && pv !== 0) delta = ((v - pv) / Math.abs(pv)) * 100
          const isOn = active.includes(m.key)
          const dir = delta == null ? 'flat' : delta === 0 ? 'flat' : (delta > 0) === !m.goodLow ? 'up' : 'down'
          return (
            <button key={m.key} className={`az-kpi ${isOn ? 'on' : ''}`} style={{ ['--c' as string]: m.color }} onClick={() => toggle(m.key)} title={`${isOn ? 'Remove from' : 'Add to'} chart`}>
              <span className="lab"><span className="dot" />{m.label}</span>
              <span className="v">{fmtVal(m, v)}</span>
              <span className={`d ${dir}`}>{delta == null ? <span style={{ color: 'var(--ink3)' }}>—</span> : <>{delta > 0 ? '▲' : delta < 0 ? '▼' : ''} {Math.abs(delta).toFixed(1)}%</>}</span>
            </button>
          )
        })}
      </div>

      <div className="az-chart">
        {!hasData ? (
          <div className="az-perf-empty">No performance data in this period.</div>
        ) : (
          <>
            <div className="az-chart-legend">
              {activeMetrics.map((m) => <span key={m.key} className="lg"><i style={{ background: m.color }} />{m.label}</span>)}
            </div>
            <div style={{ height: 280 }}>
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={points} margin={{ top: 6, right: 8, left: 4, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#e7e7e7" vertical={false} />
                  <XAxis dataKey="date" tickLine={false} axisLine={{ stroke: '#d5d9d9' }} tick={{ fontSize: 11, fill: '#565959' }} tickFormatter={(d: string) => d.slice(5)} minTickGap={24} />
                  {activeMetrics.map((m, i) => (
                    <YAxis key={m.key} yAxisId={m.key} orientation={i === 0 ? 'left' : 'right'} hide={i > 1} domain={[0, 'auto']} width={52} tickLine={false} axisLine={false} tick={{ fontSize: 11, fill: m.color }} tickFormatter={(v: number) => fmtAxis(m, v)} />
                  ))}
                  <Tooltip
                    contentStyle={{ background: '#fff', border: '1px solid #d5d9d9', borderRadius: 8, fontSize: 12, padding: '8px 12px', boxShadow: '0 4px 16px rgba(0,0,0,.12)' }}
                    labelStyle={{ fontWeight: 700, marginBottom: 4, color: '#0f1111' }}
                    formatter={(value: unknown, name: unknown) => { const key = String(name); const m = META[key]; const v = Array.isArray(value) ? Number(value[0]) : value == null ? null : Number(value); return [fmtVal(m, v), m?.label ?? key] }}
                    labelFormatter={(d) => String(d)}
                    cursor={{ stroke: '#687070', strokeDasharray: '3 3' }}
                  />
                  {activeMetrics.map((m) => (
                    <Line key={m.key} yAxisId={m.key} type="monotone" dataKey={m.key} name={m.key} stroke={m.color} strokeWidth={2} dot={false} connectNulls isAnimationActive={false} />
                  ))}
                </LineChart>
              </ResponsiveContainer>
            </div>
          </>
        )}
      </div>
    </div>
  )
}
