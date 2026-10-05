'use client'

/**
 * ER3.3 (delta 7) — KPI strip: 8 tiles (+ROAS, C8 parity), CVR subtext on
 * Sold, hand-rolled SVG sparklines from the trend points (no new deps).
 */
import { useMemo } from 'react'
import { pctP, intlN, type SummaryPayload, type TrendPayload } from '../_lib'
import { money } from '../../campaigns/_grid/format'
import { moneyPerCurrency, ratioPerCurrency, type CurrencyTotal } from '../_lib/currencyTotals'

/** AM-21 — the tile note when the picked markets report in more than one currency. */
const MIXED_NOTE = 'These markets report in different currencies, so each currency has its own total. Nothing is converted.'

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
    // A window that spans currencies has no money per day (null): no money sparkline then, rather than a sum of two.
    const moneyLine = (v: Array<number | null>) => (v.some((x) => x == null) ? [] : (v as number[]))
    return {
      fees: moneyLine(p.map((x) => x.adFeesCents)), sales: moneyLine(p.map((x) => x.salesCents)),
      clicks: p.map((x) => x.clicks), impressions: p.map((x) => x.impressions),
    }
  }, [trend])
  // AM-21 — one currency: its own symbol. Several (all markets with eBay GB): one total per currency, never one sum.
  const mixed = s != null && s.currency == null
  const ccy = s?.currency ?? 'EUR'
  const perCcy: CurrencyTotal[] = (s?.byCurrency ?? []).map((b) => ({ currency: b.currency, feesCents: b.current.adFeesCents, salesCents: b.current.salesCents }))
  const fees = !s ? '—' : mixed ? moneyPerCurrency(perCcy, (t) => t.feesCents) : money(s.current.adFeesCents, ccy)
  const sales = !s ? '—' : mixed ? moneyPerCurrency(perCcy, (t) => t.salesCents) : money(s.current.salesCents, ccy)
  const acos = !s ? '—' : mixed ? ratioPerCurrency(perCcy, (t) => (t.salesCents > 0 ? (t.feesCents / t.salesCents) * 100 : null), (v) => pctP(v)) : pctP(s.current.acosPct)
  const roas = !s ? '—' : mixed
    ? ratioPerCurrency(perCcy, (t) => (t.feesCents > 0 ? t.salesCents / t.feesCents : null), (v) => v.toFixed(2))
    : (s.current.adFeesCents ?? 0) > 0 ? ((s.current.salesCents ?? 0) / s.current.adFeesCents!).toFixed(2) : '—'
  const cvr = s && s.current.clicks > 0 ? (s.current.soldQty / s.current.clicks) * 100 : null
  const moneyTip = mixed ? MIXED_NOTE : undefined
  return (
    <div className="dash-kpis">
      <div className="dash-kpi"><div className="dash-kpi-k">CAMPAIGNS</div><div className="dash-kpi-v">{intlN(campaignsTotal)}</div></div>
      <div className="dash-kpi"><div className="dash-kpi-k" title={moneyTip}>AD FEES</div><div className="dash-kpi-v">{fees}<Delta pct={s?.deltas.adFeesPct ?? null} goodUp={false} /></div><Spark values={series.fees} /></div>
      <div className="dash-kpi"><div className="dash-kpi-k" title={moneyTip}>AD SALES</div><div className="dash-kpi-v">{sales}<Delta pct={s?.deltas.salesPct ?? null} goodUp /></div><Spark values={series.sales} /></div>
      <div className="dash-kpi"><div className="dash-kpi-k" title={moneyTip}>EBAY ACOS</div><div className="dash-kpi-v">{acos}</div></div>
      <div className="dash-kpi"><div className="dash-kpi-k" title={moneyTip ?? 'Attributed sales ÷ ad fees (any-click)'}>ROAS</div><div className="dash-kpi-v">{roas}</div></div>
      <div className="dash-kpi"><div className="dash-kpi-k">CLICKS</div><div className="dash-kpi-v">{s ? intlN(s.current.clicks) : '—'}<Delta pct={s?.deltas.clicksPct ?? null} goodUp /></div><Spark values={series.clicks} /></div>
      <div className="dash-kpi"><div className="dash-kpi-k">IMPRESSIONS</div><div className="dash-kpi-v">{s ? intlN(s.current.impressions) : '—'}<Delta pct={s?.deltas.impressionsPct ?? null} goodUp /></div><Spark values={series.impressions} /></div>
      <div className="dash-kpi"><div className="dash-kpi-k">SOLD</div><div className="dash-kpi-v">{s ? intlN(s.current.soldQty) : '—'}</div>{cvr != null && <div className="eb-kpi-sub" title="Sold ÷ clicks in the window">CVR {cvr.toFixed(1)}%</div>}</div>
    </div>
  )
}
