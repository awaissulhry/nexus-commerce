'use client'

/**
 * Trading Desk — Analytics (native). Profit-native trend dashboard from
 * GET /advertising/trends (daily adSpend/adSales/totalRevenue → ACOS/TACOS +
 * period-over-period summary). KPI strip with vs-prior deltas + a toggleable
 * line chart (recharts).
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import { LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid, Legend } from 'recharts'
import { RefreshCw } from 'lucide-react'
import { getBackendUrl } from '@/lib/backend-url'

interface Row { date: string; impressions: number; clicks: number; orders: number; adSpendCents: number; adSalesCents: number; totalRevenueCents: number; acos: number | null; tacos: number | null; ctr: number | null }
interface Summary { impressions: number; clicks: number; orders: number; spendCents: number; salesCents: number; acos: number | null; roas: number | null; ctr: number | null }
interface Trends { rows: Row[]; summary: Summary; previous: Summary | null }

const eur = (c: number | null | undefined) => (c == null ? '—' : new Intl.NumberFormat('en-IE', { style: 'currency', currency: 'EUR', maximumFractionDigits: 0 }).format(c / 100))
const num = (n: number | null | undefined) => (n == null ? '—' : new Intl.NumberFormat('en-US').format(Math.round(n)))
const pct = (v: number | null | undefined) => (v == null ? '—' : `${v.toFixed(1)}%`)
const x2 = (v: number | null | undefined) => (v == null ? '—' : `${v.toFixed(2)}×`)

const METRICS = [
  { key: 'spend', label: 'Spend', color: '#d97706', axis: 'l' as const },
  { key: 'sales', label: 'Sales', color: '#16a34a', axis: 'l' as const },
  { key: 'acos', label: 'ACOS', color: '#4f46e5', axis: 'r' as const },
  { key: 'tacos', label: 'TACOS', color: '#7c3aed', axis: 'r' as const },
]

export function AnalyticsClient({ initial }: { initial: Trends | null }) {
  const [data, setData] = useState<Trends | null>(initial)
  const [loading, setLoading] = useState(false)
  const [on, setOn] = useState<Set<string>>(() => new Set(['spend', 'sales', 'acos']))

  const refetch = useCallback(async () => {
    setLoading(true)
    try { const d = await fetch(`${getBackendUrl()}/api/advertising/trends?preset=last-30d&compare=true`, { cache: 'no-store' }).then((r) => r.json()).catch(() => null); setData(d as Trends) } finally { setLoading(false) }
  }, [])
  useEffect(() => { if (!initial) void refetch() }, [initial, refetch])

  const chart = useMemo(() => (data?.rows ?? []).map((r) => ({ date: r.date.slice(5), spend: r.adSpendCents / 100, sales: r.adSalesCents / 100, acos: r.acos, tacos: r.tacos })), [data])
  const s = data?.summary, p = data?.previous
  const delta = (cur: number | null | undefined, prev: number | null | undefined, goodUp: boolean) => {
    if (prev == null || prev === 0 || cur == null) return null
    const d = Math.round(((cur - prev) / prev) * 1000) / 10
    return { d, good: goodUp ? d >= 0 : d <= 0 }
  }
  const Delta = ({ x }: { x: { d: number; good: boolean } | null }) => x == null ? null : <div className={`dlt ${x.good ? 'up' : 'down'}`}>{x.d >= 0 ? '▲' : '▼'} {Math.abs(x.d)}%</div>

  return (
    <>
      <div className="top">
        <div><h1>Analytics</h1><div className="sub">Last 30 days · profit-native trends</div></div>
        <span className="spacer" />
        <button className="ctl" onClick={() => void refetch()} title="Refresh"><RefreshCw size={14} className={loading ? 'spin' : ''} /></button>
      </div>

      <div className="scroll">
        <div className="grid5" style={{ marginBottom: 16 }}>
          <div className="card kpi"><div className="lbl">Ad spend</div><div className="val">{eur(s?.spendCents)}</div><Delta x={delta(s?.spendCents, p?.spendCents, false)} /></div>
          <div className="card kpi"><div className="lbl">Ad sales</div><div className="val">{eur(s?.salesCents)}</div><Delta x={delta(s?.salesCents, p?.salesCents, true)} /></div>
          <div className="card kpi"><div className="lbl">ACOS</div><div className="val">{pct(s?.acos)}</div><Delta x={delta(s?.acos, p?.acos, false)} /></div>
          <div className="card kpi"><div className="lbl">ROAS</div><div className="val">{x2(s?.roas)}</div><Delta x={delta(s?.roas, p?.roas, true)} /></div>
          <div className="card kpi"><div className="lbl">Orders</div><div className="val">{num(s?.orders)}</div><Delta x={delta(s?.orders, p?.orders, true)} /></div>
        </div>

        <div className="card">
          <div className="hd">Trend<span className="mut">· daily</span><span className="spacer" style={{ flex: 1 }} />
            <span className="chips">
              {METRICS.map((m) => {
                const active = on.has(m.key)
                return (
                  <button key={m.key} className={`chip ${active ? 'on' : 'off'}`} onClick={() => setOn((s2) => { const n = new Set(s2); if (n.has(m.key)) n.delete(m.key); else n.add(m.key); return n })}>
                    <span className="dot" style={{ background: m.color }} />{m.label}
                  </button>
                )
              })}
            </span>
          </div>
          <div className="bd">
            {chart.length === 0 ? <div className="empty">No trend data in this window.</div> : (
              <div style={{ height: 300 }}>
                <ResponsiveContainer width="100%" height="100%">
                  <LineChart data={chart} margin={{ top: 8, right: 12, left: 0, bottom: 0 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#eef0f3" />
                    <XAxis dataKey="date" tick={{ fontSize: 10, fill: '#94a3b8' }} />
                    <YAxis yAxisId="l" tick={{ fontSize: 10, fill: '#94a3b8' }} width={48} />
                    <YAxis yAxisId="r" orientation="right" tick={{ fontSize: 10, fill: '#94a3b8' }} width={40} unit="%" />
                    <Tooltip contentStyle={{ fontSize: 12, borderRadius: 8, border: '1px solid #e6e8ec' }} />
                    <Legend wrapperStyle={{ fontSize: 11 }} />
                    {METRICS.filter((m) => on.has(m.key)).map((m) => (
                      <Line key={m.key} yAxisId={m.axis} type="monotone" dataKey={m.key} stroke={m.color} strokeWidth={2} dot={false} name={m.label} />
                    ))}
                  </LineChart>
                </ResponsiveContainer>
              </div>
            )}
          </div>
        </div>

        <p className="foot-note">Ad spend/sales/ACOS from your campaign reports; TACOS overlays total revenue (DailySalesAggregate). True-profit, search-term & report-builder views land here next.</p>
      </div>
    </>
  )
}
