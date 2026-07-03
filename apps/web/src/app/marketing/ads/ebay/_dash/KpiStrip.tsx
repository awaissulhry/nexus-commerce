'use client'

/**
 * ER3.3 (delta 7) — KPI strip: 8 tiles (+ROAS, C8 parity), CVR subtext on
 * Sold, hand-rolled SVG sparklines from the trend points (no new deps).
 */
import { useMemo } from 'react'
import { eurC, pctP, intlN, type SummaryPayload, type TrendPayload } from '../_lib'

function Delta({ pct, goodUp }: { pct: number | null; goodUp: boolean }) {
  if (pct == null) return null
  const up = pct >= 0
  const good = up === goodUp
  return <span className={`dd ${good ? 'up' : 'down'}`}>{up ? '▲' : '▼'} {Math.abs(pct).toFixed(0)}%</span>
}

function Spark({ values }: { values: number[] }) {
  if (values.length < 2 || values.every((v) => v === 0)) return null
  const w = 64, h = 16
  const max = Math.max(...values), min = Math.min(...values)
  const span = max - min || 1
  const pts = values.map((v, i) => `${((i / (values.length - 1)) * w).toFixed(1)},${(h - 2 - ((v - min) / span) * (h - 4)).toFixed(1)}`).join(' ')
  return (
    <svg className="eb-spark" width={w} height={h} viewBox={`0 0 ${w} ${h}`} aria-hidden="true">
      <polyline points={pts} fill="none" stroke="#1f6fde" strokeWidth="1.5" strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  )
}

export function KpiStrip({ s, trend, campaignsTotal }: { s: SummaryPayload | null; trend: TrendPayload | null; campaignsTotal: number }) {
  const series = useMemo(() => {
    const p = trend?.points ?? []
    return {
      fees: p.map((x) => x.adFeesCents), sales: p.map((x) => x.salesCents),
      clicks: p.map((x) => x.clicks), impressions: p.map((x) => x.impressions),
    }
  }, [trend])
  const roas = s && s.current.adFeesCents > 0 ? s.current.salesCents / s.current.adFeesCents : null
  const cvr = s && s.current.clicks > 0 ? (s.current.soldQty / s.current.clicks) * 100 : null
  return (
    <div className="dash-kpis">
      <div className="dash-kpi"><div className="dash-kpi-k">CAMPAIGNS</div><div className="dash-kpi-v">{intlN(campaignsTotal)}</div></div>
      <div className="dash-kpi"><div className="dash-kpi-k">AD FEES</div><div className="dash-kpi-v">{s ? eurC(s.current.adFeesCents) : '—'}<Delta pct={s?.deltas.adFeesPct ?? null} goodUp={false} /></div><Spark values={series.fees} /></div>
      <div className="dash-kpi"><div className="dash-kpi-k">AD SALES</div><div className="dash-kpi-v">{s ? eurC(s.current.salesCents) : '—'}<Delta pct={s?.deltas.salesPct ?? null} goodUp /></div><Spark values={series.sales} /></div>
      <div className="dash-kpi"><div className="dash-kpi-k">EBAY ACOS</div><div className="dash-kpi-v">{s ? pctP(s.current.acosPct) : '—'}</div></div>
      <div className="dash-kpi"><div className="dash-kpi-k" title="Attributed sales ÷ ad fees (any-click)">ROAS</div><div className="dash-kpi-v">{roas != null ? roas.toFixed(2) : '—'}</div></div>
      <div className="dash-kpi"><div className="dash-kpi-k">CLICKS</div><div className="dash-kpi-v">{s ? intlN(s.current.clicks) : '—'}<Delta pct={s?.deltas.clicksPct ?? null} goodUp /></div><Spark values={series.clicks} /></div>
      <div className="dash-kpi"><div className="dash-kpi-k">IMPRESSIONS</div><div className="dash-kpi-v">{s ? intlN(s.current.impressions) : '—'}<Delta pct={s?.deltas.impressionsPct ?? null} goodUp /></div><Spark values={series.impressions} /></div>
      <div className="dash-kpi"><div className="dash-kpi-k">SOLD</div><div className="dash-kpi-v">{s ? intlN(s.current.soldQty) : '—'}</div>{cvr != null && <div className="eb-kpi-sub" title="Sold ÷ clicks in the window">CVR {cvr.toFixed(1)}%</div>}</div>
    </div>
  )
}
