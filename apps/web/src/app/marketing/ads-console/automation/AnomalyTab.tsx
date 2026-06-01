'use client'

/**
 * Anomaly detection — surfaces sudden spend / ACOS / CTR / CVR / sales moves vs
 * their trailing baseline (and period-over-period), the way Pacvue/Skai flag
 * outliers. Pure client-side analysis over GET /advertising/trends — points the
 * operator at the right alert/guard automation to set up.
 */

import { useEffect, useMemo, useState } from 'react'
import { AlertTriangle, TrendingUp, TrendingDown, RefreshCw } from 'lucide-react'
import { getBackendUrl } from '@/lib/backend-url'
import { TabControls, DEFAULT_RANGE, rangeQuery, type RangeValue } from './TabControls'

interface Row { date: string; impressions: number; clicks: number; orders: number; adSpendCents: number; adSalesCents: number; acos: number | null; ctr: number | null }
interface Summary { impressions: number; clicks: number; orders: number; spendCents: number; salesCents: number; acos: number | null; roas: number | null; ctr: number | null }
interface Anomaly { metric: string; dir: 'up' | 'down'; latest: string; baseline: string; deltaPct: number; severity: 'high' | 'medium' | 'low'; good: boolean; note: string }

const eur = (c: number) => new Intl.NumberFormat('en-IE', { style: 'currency', currency: 'EUR', maximumFractionDigits: 0 }).format(c / 100)
const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0)

export function AnomalyTab() {
  const [rows, setRows] = useState<Row[]>([])
  const [summary, setSummary] = useState<Summary | null>(null)
  const [previous, setPrevious] = useState<Summary | null>(null)
  const [loading, setLoading] = useState(true)
  const [range, setRange] = useState<RangeValue>(DEFAULT_RANGE)
  const load = () => { setLoading(true); void fetch(`${getBackendUrl()}/api/advertising/trends?${rangeQuery(range)}&compare=true`, { cache: 'no-store' }).then((r) => r.json()).then((d) => { setRows(d.rows ?? []); setSummary(d.summary ?? null); setPrevious(d.previous ?? null) }).catch(() => {}).finally(() => setLoading(false)) }
  useEffect(() => { load() }, [range]) // eslint-disable-line react-hooks/exhaustive-deps

  const anomalies = useMemo<Anomaly[]>(() => {
    const out: Anomaly[] = []
    const usable = rows.filter((r) => r.impressions > 0 || r.adSpendCents > 0)
    if (usable.length >= 5) {
      const last = usable[usable.length - 1]
      const prior = usable.slice(0, -1)
      const checks: Array<{ metric: string; val: (r: Row) => number; latestFmt: (n: number) => string; good: 'up' | 'down'; up: number; down: number }> = [
        { metric: 'Ad spend', val: (r) => r.adSpendCents, latestFmt: eur, good: 'down', up: 1.8, down: 0.4 },
        { metric: 'Ad sales', val: (r) => r.adSalesCents, latestFmt: eur, good: 'up', up: 1.8, down: 0.5 },
        { metric: 'ACOS', val: (r) => r.acos ?? 0, latestFmt: (n) => `${n.toFixed(0)}%`, good: 'down', up: 1.5, down: 0.6 },
        { metric: 'Clicks', val: (r) => r.clicks, latestFmt: (n) => String(Math.round(n)), good: 'up', up: 2, down: 0.45 },
        { metric: 'CTR', val: (r) => r.ctr ?? 0, latestFmt: (n) => `${n.toFixed(2)}%`, good: 'up', up: 2, down: 0.5 },
        { metric: 'Orders', val: (r) => r.orders, latestFmt: (n) => String(Math.round(n)), good: 'up', up: 2.2, down: 0.4 },
      ]
      for (const c of checks) {
        const base = mean(prior.map(c.val)); const lv = c.val(last)
        if (base <= 0) continue
        const ratio = lv / base
        if (ratio >= c.up || ratio <= c.down) {
          const dir: 'up' | 'down' = ratio >= c.up ? 'up' : 'down'
          const deltaPct = (ratio - 1) * 100
          const good = dir === c.good
          const mag = Math.abs(deltaPct)
          out.push({ metric: c.metric, dir, latest: c.latestFmt(lv), baseline: c.latestFmt(base), deltaPct, good, severity: mag > 120 ? 'high' : mag > 60 ? 'medium' : 'low', note: `${last.date}: ${c.latestFmt(lv)} vs ${c.latestFmt(base)} 7-day avg` })
        }
      }
    }
    // period-over-period headline (summary vs previous)
    if (summary && previous) {
      const pop: Array<{ metric: string; cur: number; prev: number; fmt: (n: number) => string; good: 'up' | 'down' }> = [
        { metric: 'Spend (period)', cur: summary.spendCents, prev: previous.spendCents, fmt: eur, good: 'down' },
        { metric: 'Sales (period)', cur: summary.salesCents, prev: previous.salesCents, fmt: eur, good: 'up' },
        { metric: 'ACOS (period)', cur: summary.acos ?? 0, prev: previous.acos ?? 0, fmt: (n) => `${n.toFixed(0)}%`, good: 'down' },
      ]
      for (const p of pop) {
        if (p.prev <= 0) continue
        const deltaPct = (p.cur / p.prev - 1) * 100
        if (Math.abs(deltaPct) >= 30) { const dir: 'up' | 'down' = deltaPct > 0 ? 'up' : 'down'; out.push({ metric: p.metric, dir, latest: p.fmt(p.cur), baseline: p.fmt(p.prev), deltaPct, good: dir === p.good, severity: Math.abs(deltaPct) > 80 ? 'high' : 'medium', note: `vs previous period: ${p.fmt(p.cur)} vs ${p.fmt(p.prev)}` }) }
      }
    }
    return out.sort((a, b) => (a.good === b.good ? Math.abs(b.deltaPct) - Math.abs(a.deltaPct) : a.good ? 1 : -1))
  }, [rows, summary, previous])

  const sevColor = (s: string) => (s === 'high' ? '#cc1100' : s === 'medium' ? 'var(--amber)' : 'var(--ink3)')

  return (
    <div style={{ paddingTop: 4 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12 }}>
        <span style={{ fontWeight: 700 }}><AlertTriangle size={15} style={{ verticalAlign: 'text-bottom', marginRight: 5 }} />Anomaly detection</span>
        <span style={{ color: 'var(--ink2)', fontSize: 12 }}>sudden moves vs the trailing baseline</span>
        <span style={{ flex: 1 }} />
        <TabControls value={range} onChange={setRange} />
        <button className="az-iconbtn" onClick={load} title="Refresh"><RefreshCw size={15} className={loading ? 'az-spin' : ''} /></button>
      </div>
      {loading && <div className="az-empty">Analysing…</div>}
      {!loading && anomalies.length === 0 && <div className="az-empty" style={{ border: '1px solid var(--divider)', borderRadius: 10 }}>No anomalies detected — performance is steady.</div>}
      {anomalies.map((a, i) => (
        <div key={i} className="az-rec">
          <span className="sev" style={{ background: sevColor(a.severity) }} />
          <div className="body">
            <div className="t">{a.metric} {a.dir === 'up' ? <TrendingUp size={13} style={{ verticalAlign: 'text-bottom' }} /> : <TrendingDown size={13} style={{ verticalAlign: 'text-bottom' }} />} <span style={{ color: a.good ? 'var(--green)' : '#cc1100', fontWeight: 700 }}>{a.deltaPct > 0 ? '+' : ''}{a.deltaPct.toFixed(0)}%</span></div>
            <div className="d">{a.note}{a.good ? ' — favourable move' : ' — worth a look'}</div>
          </div>
          <span className="trg" style={{ background: 'var(--bg2)', borderRadius: 5, padding: '2px 8px', fontSize: 10.5, fontWeight: 700, color: 'var(--ink2)', alignSelf: 'center' }}>{a.good ? 'opportunity' : 'risk'}</span>
        </div>
      ))}
      {!loading && anomalies.length > 0 && <div style={{ color: 'var(--ink2)', fontSize: 12, padding: '12px 2px' }}>Turn these into hands-free guards: add the matching <b>Alert</b> or defensive automation from the Library so you’re notified — or protected — automatically next time.</div>}
    </div>
  )
}
