'use client'

/**
 * Efficiency — "win for the least cost". Cost-per-click, cost-per-acquisition,
 * conversion rate, average order value and ROAS, each vs the previous period,
 * with a CPC/CPA trend and the projected monthly savings the automation engine
 * can capture (from /recommendations). All live from /advertising/trends.
 */

import { useEffect, useMemo, useState } from 'react'
import { Gauge, RefreshCw, ArrowDownRight, ArrowUpRight } from 'lucide-react'
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from 'recharts'
import { getBackendUrl } from '@/lib/backend-url'
import { TabControls, DEFAULT_RANGE, rangeQuery, rangeLabel, type RangeValue } from './TabControls'

interface Row { date: string; clicks: number; orders: number; adSpendCents: number; adSalesCents: number }
interface Summary { clicks: number; orders: number; spendCents: number; salesCents: number; roas: number | null }

const eur2 = (v: number | null) => (v == null ? '—' : new Intl.NumberFormat('en-IE', { style: 'currency', currency: 'EUR' }).format(v))
const pct1 = (v: number | null) => (v == null ? '—' : `${(v * 100).toFixed(1)}%`)
const x2 = (v: number | null) => (v == null ? '—' : v.toFixed(2))

export function EfficiencyTab() {
  const [rows, setRows] = useState<Row[]>([])
  const [summary, setSummary] = useState<Summary | null>(null)
  const [previous, setPrevious] = useState<Summary | null>(null)
  const [impactCents, setImpactCents] = useState<number | null>(null)
  const [loading, setLoading] = useState(true)
  const [range, setRange] = useState<RangeValue>(DEFAULT_RANGE)
  const load = () => {
    setLoading(true)
    const b = getBackendUrl()
    Promise.all([
      fetch(`${b}/api/advertising/trends?${rangeQuery(range)}&compare=true`, { cache: 'no-store' }).then((r) => r.json()).catch(() => ({})),
      fetch(`${b}/api/advertising/recommendations?limit=2`, { cache: 'no-store' }).then((r) => r.json()).catch(() => null),
    ]).then(([t, rec]) => { setRows(t.rows ?? []); setSummary(t.summary ?? null); setPrevious(t.previous ?? null); setImpactCents(rec?.potentialMonthlyImpactCents ?? null) }).finally(() => setLoading(false))
  }
  useEffect(() => { load() }, [range]) // eslint-disable-line react-hooks/exhaustive-deps

  const m = (s: Summary | null) => {
    if (!s) return null
    return {
      cpc: s.clicks > 0 ? s.spendCents / s.clicks / 100 : null,
      cpa: s.orders > 0 ? s.spendCents / s.orders / 100 : null,
      cvr: s.clicks > 0 ? s.orders / s.clicks : null,
      aov: s.orders > 0 ? s.salesCents / s.orders / 100 : null,
      roas: s.roas ?? (s.spendCents > 0 ? s.salesCents / s.spendCents : null),
    }
  }
  const cur = useMemo(() => m(summary), [summary])
  const prev = useMemo(() => m(previous), [previous])
  const trend = useMemo(() => rows.filter((r) => r.clicks > 0).map((r) => ({ date: r.date.slice(5), cpc: Math.round(r.adSpendCents / r.clicks) / 100, cpa: r.orders > 0 ? Math.round(r.adSpendCents / r.orders) / 100 : null })), [rows])

  const kpis: Array<{ k: string; v: string; cur: number | null; prev: number | null; goodLow: boolean }> = [
    { k: 'Cost per click', v: eur2(cur?.cpc ?? null), cur: cur?.cpc ?? null, prev: prev?.cpc ?? null, goodLow: true },
    { k: 'Cost per acquisition', v: eur2(cur?.cpa ?? null), cur: cur?.cpa ?? null, prev: prev?.cpa ?? null, goodLow: true },
    { k: 'Conversion rate', v: pct1(cur?.cvr ?? null), cur: cur?.cvr ?? null, prev: prev?.cvr ?? null, goodLow: false },
    { k: 'Avg. order value', v: eur2(cur?.aov ?? null), cur: cur?.aov ?? null, prev: prev?.aov ?? null, goodLow: false },
    { k: 'ROAS', v: x2(cur?.roas ?? null), cur: cur?.roas ?? null, prev: prev?.roas ?? null, goodLow: false },
  ]

  return (
    <div style={{ paddingTop: 4 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12 }}>
        <span style={{ fontWeight: 700 }}><Gauge size={15} style={{ verticalAlign: 'text-bottom', marginRight: 5 }} />Efficiency — winning for the least cost</span>
        <span style={{ color: 'var(--ink2)', fontSize: 12 }}>{rangeLabel(range)} vs previous</span>
        <span style={{ flex: 1 }} />
        <TabControls value={range} onChange={setRange} />
        <button className="az-iconbtn" onClick={load} title="Refresh"><RefreshCw size={15} className={loading ? 'az-spin' : ''} /></button>
      </div>

      <div className="az-hero">
        {kpis.map((kp) => {
          let delta: number | null = null
          if (kp.cur != null && kp.prev != null && kp.prev !== 0) delta = (kp.cur - kp.prev) / Math.abs(kp.prev)
          const good = delta == null ? null : (delta < 0) === kp.goodLow
          return (
            <div key={kp.k} className="az-stat">
              <div className="k">{kp.k}</div>
              <div className="v">{kp.v}</div>
              <div className="s" style={{ color: good == null ? 'var(--ink2)' : good ? 'var(--green)' : '#cc1100', fontWeight: 600 }}>
                {delta == null ? 'no prior data' : <>{delta < 0 ? <ArrowDownRight size={12} style={{ verticalAlign: 'text-bottom' }} /> : <ArrowUpRight size={12} style={{ verticalAlign: 'text-bottom' }} />}{Math.abs(delta * 100).toFixed(1)}% vs prev</>}
              </div>
            </div>
          )
        })}
        <div className="az-stat" style={{ borderColor: '#b6e0cf', background: 'var(--green-bg)' }}>
          <div className="k">Savings on the table</div>
          <div className="v" style={{ color: 'var(--green)' }}>{impactCents != null ? new Intl.NumberFormat('en-IE', { style: 'currency', currency: 'EUR', maximumFractionDigits: 0 }).format(impactCents / 100) : '—'}</div>
          <div className="s">/mo if you action recommendations</div>
        </div>
      </div>

      <div className="az-eng-card">
        <h4>Cost-per-click &amp; cost-per-acquisition trend</h4>
        <p style={{ marginBottom: 8 }}>Lower is cheaper. Bid &amp; harvest automations push these down over time.</p>
        <div style={{ height: 280 }}>
          {trend.length === 0 ? <div className="az-empty">No click data in range.</div> : (
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={trend} margin={{ left: 4, right: 8, top: 6, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#e7e7e7" vertical={false} />
                <XAxis dataKey="date" tick={{ fontSize: 11, fill: '#565959' }} minTickGap={24} />
                <YAxis tick={{ fontSize: 11, fill: '#565959' }} width={48} tickFormatter={(v: number) => `€${v.toFixed(2)}`} />
                <Tooltip contentStyle={{ fontSize: 12, borderRadius: 8, border: '1px solid #d5d9d9' }} />
                <Line type="monotone" dataKey="cpc" name="CPC" stroke="#0a7cd1" strokeWidth={2} dot={false} connectNulls />
                <Line type="monotone" dataKey="cpa" name="CPA" stroke="#ff9900" strokeWidth={2} dot={false} connectNulls />
              </LineChart>
            </ResponsiveContainer>
          )}
        </div>
        <div className="az-chart-legend" style={{ paddingTop: 8 }}><span className="lg"><i style={{ background: '#0a7cd1' }} />CPC</span><span className="lg"><i style={{ background: '#ff9900' }} />CPA (cost / order)</span></div>
      </div>
    </div>
  )
}
