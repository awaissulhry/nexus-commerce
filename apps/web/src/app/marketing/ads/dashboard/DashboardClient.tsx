'use client'
import { useEffect, useState } from 'react'
import { ResponsiveContainer, ComposedChart, Line, XAxis, YAxis, CartesianGrid, Tooltip } from 'recharts'
import { getBackendUrl } from '@/lib/backend-url'
import { AdsPageHeader } from '../_shell/AdsPageHeader'
import { eur, intl, roas as roasFmt } from '../_canvas/format'
import './dashboard.css'

interface Summary { campaignCount?: number; adSpend30dCents?: number; trueProfitMargin30dPct?: number | null; mode?: string }
interface TrendSummary { impressions?: number; clicks?: number; orders?: number; spendCents?: number; salesCents?: number; acos?: number; roas?: number }
interface TrendRow { date: string; adSpendCents?: number; acos?: number }
interface Trends { rows?: TrendRow[]; summary?: TrendSummary; previous?: TrendSummary }
interface Alert { id: string; campaignId?: string; campaignName?: string; type: string; severity: string; message: string }
interface MomRow { id?: string; label?: string; status?: string; salesCents?: number; acos?: number | null; orders?: number }
interface Momentum { campaigns?: MomRow[]; keywords?: MomRow[]; asins?: MomRow[]; placements?: { placement: string; salesCents?: number; sharePct?: number }[] }

const n = (v: unknown): number | undefined => {
  if (v === null || v === undefined || v === '') return undefined
  const x = Number(v)
  return Number.isFinite(x) ? x : undefined
}
const marginPct = (v?: number | null) => (v == null ? '—' : `${(v <= 1 ? v * 100 : v).toFixed(0)}%`)
// ACoS scale differs by endpoint (trends = percent like 38.02; campaign-list = fraction like 0.24).
// Normalize: values > 1.5 are already a percent; smaller values are a fraction → ×100.
const acosPct = (a?: number) => (a == null ? '—' : `${(Math.abs(a) > 1.5 ? a : a * 100).toFixed(0)}%`)

function Delta({ cur, prev, goodUp, neutral }: { cur?: number; prev?: number; goodUp?: boolean; neutral?: boolean }) {
  if (cur == null || prev == null || prev === 0) return null
  const ch = (cur - prev) / Math.abs(prev)
  if (Math.abs(ch) < 0.005) return <span className="dd flat">±0%</span>
  const up = ch > 0
  const cls = neutral ? 'flat' : up === !!goodUp ? 'up' : 'down'
  return <span className={`dd ${cls}`}>{up ? '▲' : '▼'} {Math.abs(ch * 100).toFixed(0)}%</span>
}

const ALERT_LABEL: Record<string, string> = {
  acos_breach: 'ACoS breach', zero_sales: 'Zero sales', spend_spike: 'Spend spike', sales_drop: 'Sales drop',
}

export function DashboardClient() {
  const [market, setMarket] = useState('all')
  const [markets, setMarkets] = useState<string[]>([])
  const [summary, setSummary] = useState<Summary | null>(null)
  const [trends, setTrends] = useState<Trends | null>(null)
  const [alerts, setAlerts] = useState<Alert[]>([])
  const [mom, setMom] = useState<Momentum | null>(null)
  const [momTab, setMomTab] = useState<'campaigns' | 'keywords' | 'asins'>('campaigns')
  const [loading, setLoading] = useState(true)

  // markets list (once)
  useEffect(() => {
    let alive = true
    fetch(`${getBackendUrl()}/api/advertising/campaigns?limit=500`, { cache: 'no-store' })
      .then((r) => r.json())
      .then((d) => {
        if (!alive) return
        const ms = Array.from(new Set((d.items ?? []).map((c: { marketplace?: string }) => c.marketplace).filter(Boolean))) as string[]
        setMarkets(ms.sort())
      })
      .catch(() => {})
    return () => { alive = false }
  }, [])

  // dashboard data (on market change)
  useEffect(() => {
    let alive = true
    setLoading(true)
    const mp = market === 'all' ? '' : `&marketplace=${market}`
    const base = getBackendUrl()
    Promise.all([
      fetch(`${base}/api/advertising/summary`, { cache: 'no-store' }).then((r) => r.json()).catch(() => null),
      fetch(`${base}/api/advertising/trends?windowDays=30&compare=true${mp}`, { cache: 'no-store' }).then((r) => r.json()).catch(() => null),
      fetch(`${base}/api/advertising/alerts?windowDays=7${mp}`, { cache: 'no-store' }).then((r) => r.json()).catch(() => null),
      fetch(`${base}/api/advertising/momentum?${mp.replace(/^&/, '')}`, { cache: 'no-store' }).then((r) => r.json()).catch(() => null),
    ]).then(([s, t, a, m]) => {
      if (!alive) return
      setSummary(s ?? null)
      setTrends(t ?? null)
      setAlerts(Array.isArray(a?.alerts) ? a.alerts : [])
      setMom(m ?? null)
      setLoading(false)
    })
    return () => { alive = false }
  }, [market])

  const ts = trends?.summary ?? {}
  const tp = trends?.previous ?? {}
  const spend = n(ts.spendCents) != null ? n(ts.spendCents)! / 100 : undefined
  const sales = n(ts.salesCents) != null ? n(ts.salesCents)! / 100 : undefined
  const kpis = [
    { k: 'Campaigns', v: intl(n(summary?.campaignCount)), d: null },
    { k: 'Spend (30d)', v: eur(spend), d: <Delta cur={n(ts.spendCents)} prev={n(tp.spendCents)} neutral /> },
    { k: 'Sales (30d)', v: eur(sales), d: <Delta cur={n(ts.salesCents)} prev={n(tp.salesCents)} goodUp /> },
    { k: 'ACoS', v: acosPct(n(ts.acos)), d: <Delta cur={n(ts.acos)} prev={n(tp.acos)} goodUp={false} /> },
    { k: 'ROAS', v: roasFmt(n(ts.roas)), d: <Delta cur={n(ts.roas)} prev={n(tp.roas)} goodUp /> },
    { k: 'Orders', v: intl(n(ts.orders)), d: <Delta cur={n(ts.orders)} prev={n(tp.orders)} goodUp /> },
    { k: 'True margin (30d)', v: marginPct(summary?.trueProfitMargin30dPct), d: null },
  ]

  const chartData = (trends?.rows ?? []).map((r) => ({
    date: r.date?.slice(5),
    spend: n(r.adSpendCents) != null ? n(r.adSpendCents)! / 100 : 0,
    acos: n(r.acos) != null ? Math.round(n(r.acos)!) : 0,
  }))

  const momRows = (mom?.[momTab] ?? []).slice(0, 8)
  const topAlerts = [...alerts].sort((x, y) => (x.severity === 'high' ? -1 : 1) - (y.severity === 'high' ? -1 : 1)).slice(0, 6)

  return (
    <div className="dash">
      <AdsPageHeader
        title="Dashboard"
        subtitle="Account performance, health and momentum at a glance."
        markets={markets}
        market={market}
        onMarketChange={setMarket}
        showDateRange={false}
        showDataSync={false}
      />

      {summary?.mode === 'sandbox' && (
        <div className="dash-banner">Sandbox mode — writes are simulated; nothing is sent to Amazon until live mode is enabled.</div>
      )}

      {/* KPI strip */}
      <div className="dash-kpis">
        {kpis.map((kp) => (
          <div className="dash-kpi" key={kp.k}>
            <div className="dash-kpi-k">{kp.k}</div>
            <div className="dash-kpi-v">{loading ? '…' : kp.v}{kp.d}</div>
          </div>
        ))}
      </div>

      {/* Trend chart */}
      <div className="dash-card">
        <div className="dash-card-h">Spend &amp; ACoS · last 30 days</div>
        <div className="dash-chart">
          {chartData.length === 0 ? (
            <div className="dash-empty">{loading ? 'Loading…' : 'No trend data for this range.'}</div>
          ) : (
            <ResponsiveContainer width="100%" height={260}>
              <ComposedChart data={chartData} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
                <CartesianGrid stroke="#eef0f3" vertical={false} />
                <XAxis dataKey="date" tick={{ fontSize: 10, fill: '#8a93a1' }} tickLine={false} axisLine={{ stroke: '#e3e7ec' }} minTickGap={24} />
                <YAxis yAxisId="l" tick={{ fontSize: 10, fill: '#8a93a1' }} tickLine={false} axisLine={false} width={48} tickFormatter={(v) => `€${v}`} />
                <YAxis yAxisId="r" orientation="right" tick={{ fontSize: 10, fill: '#8a93a1' }} tickLine={false} axisLine={false} width={40} tickFormatter={(v) => `${v}%`} />
                <Tooltip formatter={(v, name) => (name === 'spend' ? eur(Number(v)) : `${Number(v)}%`)} labelStyle={{ fontWeight: 700 }} contentStyle={{ fontSize: 12, borderRadius: 8, border: '1px solid #e3e7ec' }} />
                <Line yAxisId="l" type="monotone" dataKey="spend" stroke="#1f6fde" strokeWidth={2} dot={false} name="spend" />
                <Line yAxisId="r" type="monotone" dataKey="acos" stroke="#e5484d" strokeWidth={2} dot={false} name="acos" />
              </ComposedChart>
            </ResponsiveContainer>
          )}
        </div>
      </div>

      <div className="dash-row2">
        {/* Alerts */}
        <div className="dash-card">
          <div className="dash-card-h">Health alerts · last 7 days</div>
          {topAlerts.length === 0 ? (
            <div className="dash-empty">{loading ? 'Loading…' : 'No alerts — all clear.'}</div>
          ) : (
            <div className="dash-alerts">
              {topAlerts.map((a) => (
                <a className="dash-alert" key={a.id} href={a.campaignId ? `/marketing/ads/campaigns/${a.campaignId}` : undefined}>
                  <span className={`dash-sev dash-sev--${a.severity}`} />
                  <span className={`dash-atype dash-atype--${a.type}`}>{ALERT_LABEL[a.type] ?? a.type}</span>
                  <span className="dash-amsg" title={a.message}>{a.campaignName ? `${a.campaignName} — ` : ''}{a.message}</span>
                </a>
              ))}
            </div>
          )}
        </div>

        {/* Momentum */}
        <div className="dash-card">
          <div className="dash-card-h">
            Top movers · latest day
            <span className="dash-seg">
              {(['campaigns', 'keywords', 'asins'] as const).map((t) => (
                <button key={t} type="button" className={momTab === t ? 'on' : ''} onClick={() => setMomTab(t)}>{t}</button>
              ))}
            </span>
          </div>
          {momRows.length === 0 ? (
            <div className="dash-empty">{loading ? 'Loading…' : 'No momentum data yet.'}</div>
          ) : (
            <div className="dash-mom">
              {momRows.map((r, i) => (
                <div className="dash-momrow" key={(r.id ?? '') + i}>
                  <span className="dash-momname" title={r.label}>{r.label ?? '—'}</span>
                  <span className="dash-momv">{eur(n(r.salesCents) != null ? n(r.salesCents)! / 100 : undefined)}</span>
                  <span className="dash-momv">{acosPct(n(r.acos))}</span>
                  <span className="dash-momv">{intl(n(r.orders))} ord</span>
                </div>
              ))}
            </div>
          )}
          {mom?.placements && mom.placements.length > 0 && (
            <div className="dash-place">
              {mom.placements.map((p) => (
                <div className="dash-pl" key={p.placement}>
                  <span className="dash-pl-k">{p.placement.replace('PLACEMENT_', '').replace(/_/g, ' ')}</span>
                  <span className="dash-pl-bar"><span style={{ width: `${Math.min(100, Math.round(p.sharePct ?? 0))}%` }} /></span>
                  <span className="dash-pl-v">{Math.round(p.sharePct ?? 0)}%</span>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
