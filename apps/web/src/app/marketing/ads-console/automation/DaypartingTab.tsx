'use client'

/**
 * Dayparting — demand intelligence (DP.3) → Amazon bid control (DP.4).
 *
 * The real hour-of-day signal comes from ORDERS (the Amazon hourly ad stream is
 * dormant), so this reads GET /advertising/orders-dayparting: a weekday × hour
 * (Europe/Rome) demand heatmap, filterable by market, product/SKU, metric, and
 * any date range. Peak/trough hours + a recommended "bid up here" window flow
 * straight into an Amazon bid schedule (DP.4). An optional Amazon ad-spend
 * overlay (DP.5) lights up when Marketing Stream is provisioned.
 */

import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Clock, Search, X, TrendingUp, TrendingDown, Package, Zap, Plus, Trash2 } from 'lucide-react'
import { getBackendUrl } from '@/lib/backend-url'
import { useCampaignMap, type CampRef } from './useCampaignMap'

type Metric = 'revenue' | 'orders' | 'units'
interface Bucket { orders: number; units: number; revenueCents: number }
interface Profile extends Bucket { key: number; index: number | null }
interface Daypart {
  timezone: string; channel: string; metric: Metric; from: string; to: string
  totals: Bucket; grid: Bucket[][]; hourProfile: Profile[]; weekdayProfile: Profile[]
  peakHours: number[]; troughHours: number[]
  recommendedWindow: { days: number[]; startHour: number; endHour: number } | null
  hasData: boolean; currencyNote: string
}
interface ProductHit { id: string; sku: string; name: string; imageUrl: string | null }
interface SchedWindow { days?: number[]; startHour?: number; endHour?: number; bidMultiplierPct?: number }
interface Sched { id: string; campaignId: string; name: string; windows: SchedWindow[]; timezone: string; enabled: boolean; lastApplied: string | null; lastEvaluatedAt: string | null }
const BID_LADDER = [-50, -25, 0, 25, 50]

// Display weekdays Mon-first; data dow is 0=Sun..6=Sat → map row i to this dow.
const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']
const DOW_ORDER = [1, 2, 3, 4, 5, 6, 0]
const MARKETS = ['IT', 'DE', 'FR', 'ES'] // quick chips; "All" still captures any other market
const METRICS: { k: Metric; label: string }[] = [{ k: 'revenue', label: 'Revenue' }, { k: 'orders', label: 'Orders' }, { k: 'units', label: 'Units' }]
const PRESETS = [7, 30, 90, 180, 365]

const eur = (c: number) => new Intl.NumberFormat('en-IE', { style: 'currency', currency: 'EUR', maximumFractionDigits: 0 }).format(c / 100)
const fmtHr = (h: number) => `${String(h).padStart(2, '0')}:00`
const metricVal = (b: Bucket, m: Metric) => (m === 'revenue' ? b.revenueCents : m === 'orders' ? b.orders : b.units)
const metricFmt = (v: number, m: Metric) => (m === 'revenue' ? eur(v) : v.toLocaleString('en-IE'))
// Perceptual green heat scale (sqrt spread so a few big cells don't wash out the rest).
const heat = (v: number, max: number) => {
  if (max <= 0 || v <= 0) return '#f7f8f8'
  const t = Math.sqrt(Math.min(1, v / max))
  const a = [232, 245, 240], b = [6, 125, 98]
  return `rgb(${a.map((x, i) => Math.round(x + (b[i] - x) * t)).join(',')})`
}
const heatText = (v: number, max: number) => (max > 0 && Math.sqrt(v / max) > 0.6 ? '#fff' : 'var(--ink3)')

export function DaypartingTab() {
  const [market, setMarket] = useState('')            // '' = all markets
  const [metric, setMetric] = useState<Metric>('revenue')
  const [days, setDays] = useState(90)                 // preset window
  const [custom, setCustom] = useState<{ from: string; to: string } | null>(null)
  const [product, setProduct] = useState<ProductHit | null>(null)
  const [data, setData] = useState<Daypart | null>(null)
  const [loading, setLoading] = useState(true)

  // product typeahead
  const [pq, setPq] = useState('')
  const [hits, setHits] = useState<ProductHit[]>([])
  const [showHits, setShowHits] = useState(false)
  const pickRef = useRef<HTMLDivElement>(null)

  const qs = useMemo(() => {
    const p = new URLSearchParams({ channel: 'AMAZON', metric })
    if (market) p.set('marketplace', market)
    if (product) p.set('productId', product.id)
    if (custom?.from && custom?.to) { p.set('from', custom.from); p.set('to', new Date(custom.to + 'T23:59:59').toISOString()) }
    else p.set('windowDays', String(days))
    return p.toString()
  }, [market, metric, product, days, custom])

  useEffect(() => {
    let alive = true
    setLoading(true)
    void fetch(`${getBackendUrl()}/api/advertising/orders-dayparting?${qs}`, { cache: 'no-store' })
      .then((r) => r.json()).then((d) => { if (alive) { setData(d); setLoading(false) } })
      .catch(() => { if (alive) setLoading(false) })
    return () => { alive = false }
  }, [qs])

  // typeahead fetch (debounced)
  useEffect(() => {
    if (!pq.trim()) { setHits([]); return }
    const t = setTimeout(() => {
      void fetch(`${getBackendUrl()}/api/products/search?search=${encodeURIComponent(pq.trim())}&limit=8`, { cache: 'no-store' })
        .then((r) => r.json()).then((d) => setHits((d.items ?? []).map((i: ProductHit) => ({ id: i.id, sku: i.sku, name: i.name, imageUrl: i.imageUrl })))).catch(() => {})
    }, 250)
    return () => clearTimeout(t)
  }, [pq])
  useEffect(() => {
    const onDoc = (e: MouseEvent) => { if (pickRef.current && !pickRef.current.contains(e.target as Node)) setShowHits(false) }
    document.addEventListener('mousedown', onDoc); return () => document.removeEventListener('mousedown', onDoc)
  }, [])
  const pick = useCallback((h: ProductHit) => { setProduct(h); setPq(''); setHits([]); setShowHits(false) }, [])

  // ── DP.4: bid-schedule control ──
  const campMap = useCampaignMap()
  const byLocalId = useMemo(() => { const m: Record<string, CampRef> = {}; for (const c of Object.values(campMap)) m[c.id] = c; return m }, [campMap])
  const marketCampaigns = useMemo(() => Object.values(campMap).filter((c) => !market || c.marketplace === market).sort((a, b) => a.name.localeCompare(b.name)), [campMap, market])
  const [schedules, setSchedules] = useState<Sched[]>([])
  const [showCreate, setShowCreate] = useState(false)
  const [selCampaign, setSelCampaign] = useState('')
  const [bidPct, setBidPct] = useState(25)
  const [win, setWin] = useState({ start: 9, end: 21, days: [0, 1, 2, 3, 4, 5, 6] as number[] })
  const [schedName, setSchedName] = useState('')
  const [enableNow, setEnableNow] = useState(false)
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState('')

  const loadSchedules = useCallback(() => {
    void fetch(`${getBackendUrl()}/api/advertising/schedules`, { cache: 'no-store' }).then((r) => r.json()).then((d) => setSchedules(d.items ?? [])).catch(() => {})
  }, [])
  useEffect(() => { loadSchedules() }, [loadSchedules])

  const openCreate = () => {
    const r = data?.recommendedWindow
    setWin(r ? { start: r.startHour, end: r.endHour, days: r.days } : { start: 9, end: 21, days: [0, 1, 2, 3, 4, 5, 6] })
    setBidPct(25)
    setSchedName(r ? `Peak ${fmtHr(r.startHour)}–${fmtHr(r.endHour)}${market ? ` · ${market}` : ''}` : `Dayparting${market ? ` · ${market}` : ''}`)
    setSelCampaign(marketCampaigns.length === 1 ? marketCampaigns[0].id : '')
    setEnableNow(false); setMsg(''); setShowCreate(true)
  }
  const createSchedule = async () => {
    if (!selCampaign) { setMsg('Pick a campaign first.'); return }
    if (!win.days.length) { setMsg('Pick at least one day.'); return }
    setBusy(true); setMsg('')
    try {
      const body = { campaignId: selCampaign, name: schedName.trim() || 'Dayparting schedule', windows: [{ days: win.days, startHour: win.start, endHour: win.end, bidMultiplierPct: bidPct }], timezone: 'Europe/Rome', enabled: enableNow }
      const r = await fetch(`${getBackendUrl()}/api/advertising/schedules`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
      if (r.ok) { setShowCreate(false); setMsg(enableNow ? 'Schedule created and enabled.' : 'Schedule created (disabled — enable it below when ready).'); loadSchedules() }
      else { const e = await r.json().catch(() => null); setMsg(e?.error ? `Could not save: ${e.error}` : `Could not save (HTTP ${r.status}).`) }
    } catch { setMsg('Could not reach the schedules API.') } finally { setBusy(false) }
  }
  const toggleSched = async (s: Sched) => { setBusy(true); try { await fetch(`${getBackendUrl()}/api/advertising/schedules/${s.id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled: !s.enabled }) }); loadSchedules() } finally { setBusy(false) } }
  const delSched = async (s: Sched) => { if (typeof window !== 'undefined' && !window.confirm(`Delete schedule "${s.name}"?`)) return; setBusy(true); try { await fetch(`${getBackendUrl()}/api/advertising/schedules/${s.id}`, { method: 'DELETE' }); loadSchedules() } finally { setBusy(false) } }
  const toggleDay = (dow: number) => setWin((w) => ({ ...w, days: w.days.includes(dow) ? w.days.filter((d) => d !== dow) : [...w.days, dow].sort((a, b) => a - b) }))
  const dayLabel = (ds: number[] = []) => (ds.length === 7 ? 'Every day' : DOW_ORDER.filter((d) => ds.includes(d)).map((d) => DAYS[DOW_ORDER.indexOf(d)]).join(', '))
  const winSummary = (ws: SchedWindow[]) => (Array.isArray(ws) && ws.length ? ws.map((w) => `${dayLabel(w.days ?? [0, 1, 2, 3, 4, 5, 6])} ${fmtHr(w.startHour ?? 0)}–${fmtHr(w.endHour ?? 24)}${w.bidMultiplierPct ? ` ${w.bidMultiplierPct > 0 ? '+' : ''}${w.bidMultiplierPct}%` : ''}`).join(' · ') : 'Always on')

  // derived display values
  const maxCell = useMemo(() => (data ? Math.max(0, ...data.grid.flat().map((c) => metricVal(c, metric))) : 0), [data, metric])
  const maxHour = useMemo(() => (data ? Math.max(1, ...data.hourProfile.map((b) => metricVal(b, metric))) : 1), [data, metric])
  const maxWd = useMemo(() => (data ? Math.max(1, ...data.weekdayProfile.map((b) => metricVal(b, metric))) : 1), [data, metric])
  const bestHour = useMemo(() => (data ? data.hourProfile.reduce((a, b) => (metricVal(b, metric) > metricVal(a, metric) ? b : a), data.hourProfile[0]) : null), [data, metric])
  const bestWd = useMemo(() => (data ? data.weekdayProfile.reduce((a, b) => (metricVal(b, metric) > metricVal(a, metric) ? b : a), data.weekdayProfile[0]) : null), [data, metric])
  const rec = data?.recommendedWindow
  const mLabel = METRICS.find((m) => m.k === metric)!.label

  return (
    <div style={{ paddingTop: 4 }}>
      <div style={{ color: 'var(--ink2)', fontSize: 12.5, marginBottom: 12 }}>
        When your customers actually buy — by hour and weekday, in Rome time. Filter by market and product, pick any period, then turn a peak window into an Amazon bid schedule below.
      </div>

      {/* ── filter bar ── */}
      <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', marginBottom: 12 }}>
        {/* market */}
        <div style={{ display: 'inline-flex', gap: 4, alignItems: 'center' }}>
          <button className={`az-chip quick ${market === '' ? 'on' : ''}`} onClick={() => setMarket('')}>All markets</button>
          {MARKETS.map((m) => <button key={m} className={`az-chip quick ${market === m ? 'on' : ''}`} onClick={() => setMarket(m)}>{m}</button>)}
        </div>
        <span style={{ width: 1, height: 18, background: 'var(--divider)' }} />
        {/* metric */}
        <div style={{ display: 'inline-flex', gap: 4 }}>
          {METRICS.map((m) => <button key={m.k} className={`az-chip quick ${metric === m.k ? 'on' : ''}`} onClick={() => setMetric(m.k)}>{m.label}</button>)}
        </div>
        <span style={{ flex: 1 }} />
        {/* product typeahead */}
        <div ref={pickRef} style={{ position: 'relative' }}>
          {product ? (
            <span className="az-chip quick on" style={{ display: 'inline-flex', alignItems: 'center', gap: 6, maxWidth: 280 }} title={product.name}>
              <Package size={12} /><b style={{ fontWeight: 700 }}>{product.sku}</b>
              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: 'var(--ink2)', fontWeight: 500 }}>{product.name}</span>
              <X size={13} style={{ cursor: 'pointer' }} onClick={() => setProduct(null)} aria-label="Clear product filter" />
            </span>
          ) : (
            <div className="az-search" style={{ minWidth: 230, padding: '5px 9px' }}>
              <Search size={14} />
              <input placeholder="All products — filter to one SKU…" value={pq} onFocus={() => setShowHits(true)} onChange={(e) => { setPq(e.target.value); setShowHits(true) }} />
            </div>
          )}
          {showHits && hits.length > 0 && !product && (
            <div style={{ position: 'absolute', top: '100%', right: 0, marginTop: 4, zIndex: 30, background: '#fff', border: '1px solid var(--border)', borderRadius: 8, boxShadow: '0 8px 24px rgba(0,0,0,.12)', minWidth: 320, maxHeight: 320, overflowY: 'auto' }}>
              {hits.map((h) => (
                <button key={h.id} onClick={() => pick(h)} style={{ display: 'flex', alignItems: 'center', gap: 9, width: '100%', textAlign: 'left', padding: '7px 10px', border: 'none', borderBottom: '1px solid var(--divider)', background: 'transparent', cursor: 'pointer' }}>
                  {h.imageUrl ? <img src={h.imageUrl} alt="" width={26} height={26} style={{ borderRadius: 4, objectFit: 'cover', flexShrink: 0 }} /> : <span style={{ width: 26, height: 26, borderRadius: 4, background: 'var(--bg2)', flexShrink: 0 }} />}
                  <span style={{ minWidth: 0 }}><span style={{ fontWeight: 700, fontSize: 12 }}>{h.sku}</span><span style={{ display: 'block', fontSize: 11, color: 'var(--ink2)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{h.name}</span></span>
                </button>
              ))}
            </div>
          )}
        </div>
        {/* date range */}
        <select value={custom ? 'custom' : String(days)} onChange={(e) => { if (e.target.value === 'custom') { const to = new Date().toISOString().slice(0, 10); const from = new Date(Date.now() - 90 * 86400000).toISOString().slice(0, 10); setCustom({ from, to }) } else { setCustom(null); setDays(Number(e.target.value)) } }} style={{ border: '1px solid var(--border)', borderRadius: 6, padding: '6px 8px', font: 'inherit', cursor: 'pointer' }}>
          {PRESETS.map((d) => <option key={d} value={d}>Last {d} days</option>)}
          <option value="custom">Custom range…</option>
        </select>
        {custom && <span style={{ display: 'inline-flex', gap: 4, alignItems: 'center' }}>
          <input type="date" value={custom.from} max={custom.to} onChange={(e) => setCustom({ ...custom, from: e.target.value })} style={{ border: '1px solid var(--border)', borderRadius: 6, padding: '5px 7px', font: 'inherit' }} />
          <span style={{ color: 'var(--ink3)' }}>→</span>
          <input type="date" value={custom.to} min={custom.from} max={new Date().toISOString().slice(0, 10)} onChange={(e) => setCustom({ ...custom, to: e.target.value })} style={{ border: '1px solid var(--border)', borderRadius: 6, padding: '5px 7px', font: 'inherit' }} />
        </span>}
      </div>

      {/* ── stat cards ── */}
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 16 }}>
        <div className="az-stat" style={{ minWidth: 120, flex: 1 }}><div className="k">Revenue</div><div className="v">{data ? eur(data.totals.revenueCents) : '…'}</div><div className="s">{data ? `${data.totals.orders} orders · ${data.totals.units} units` : ''}</div></div>
        <div className="az-stat" style={{ minWidth: 120, flex: 1 }}><div className="k">Peak hour ({mLabel})</div><div className="v">{bestHour ? fmtHr(bestHour.key) : '…'}</div><div className="s">{bestHour ? `${metricFmt(metricVal(bestHour, metric), metric)} · idx ×${bestHour.index?.toFixed(2) ?? '—'}` : ''}</div></div>
        <div className="az-stat" style={{ minWidth: 120, flex: 1 }}><div className="k">Best weekday</div><div className="v">{bestWd ? DAYS[DOW_ORDER.indexOf(bestWd.key)] : '…'}</div><div className="s">{bestWd ? metricFmt(metricVal(bestWd, metric), metric) : ''}</div></div>
        <div className="az-stat" style={{ minWidth: 140, flex: 1 }}><div className="k">Recommended window</div><div className="v" style={{ fontSize: 15 }}>{rec ? `${fmtHr(rec.startHour)}–${fmtHr(rec.endHour)}` : '—'}</div><div className="s" style={{ color: 'var(--green)' }}>{rec ? `${rec.days.length}/7 days · bid up here` : 'no clear peak'}</div></div>
      </div>

      {/* ── hero heatmap ── */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8, flexWrap: 'wrap' }}>
        <span style={{ fontWeight: 700 }}><Clock size={15} style={{ verticalAlign: 'text-bottom', marginRight: 5 }} />{mLabel} by hour × weekday <span style={{ fontWeight: 500, color: 'var(--ink3)', fontSize: 11.5 }}>· {data?.timezone ?? 'Europe/Rome'}</span></span>
        <span style={{ flex: 1 }} />
        {/* legend */}
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 11, color: 'var(--ink2)' }}>
          less<span style={{ display: 'inline-flex', gap: 2 }}>{[0, .25, .5, .75, 1].map((t) => <span key={t} style={{ width: 14, height: 12, borderRadius: 2, background: heat(t, 1) }} />)}</span>more
        </span>
      </div>

      <div style={{ overflowX: 'auto', border: '1px solid var(--divider)', borderRadius: 8, padding: 8, background: '#fff' }}>
        <div style={{ display: 'grid', gridTemplateColumns: '40px repeat(24, 1fr)', gap: 2, minWidth: 760 }}>
          <span />
          {Array.from({ length: 24 }, (_, h) => <span key={h} style={{ fontSize: 9, color: 'var(--ink3)', textAlign: 'center' }}>{h}</span>)}
          {loading
            ? Array.from({ length: 7 }).map((_, d) => <Fragment key={d}><span style={{ fontSize: 11, fontWeight: 600, color: 'var(--ink2)', alignSelf: 'center' }}>{DAYS[d]}</span>{Array.from({ length: 24 }).map((_, h) => <span key={h} className="az-skel" style={{ height: 22, borderRadius: 3 }} />)}</Fragment>)
            : DOW_ORDER.map((dow, di) => (
              <Fragment key={dow}>
                <span style={{ fontSize: 11, fontWeight: 600, color: 'var(--ink2)', alignSelf: 'center' }}>{DAYS[di]}</span>
                {Array.from({ length: 24 }, (_, h) => {
                  const cell = data?.grid?.[dow]?.[h] ?? { orders: 0, units: 0, revenueCents: 0 }
                  const v = metricVal(cell, metric)
                  return (
                    <div key={h} title={`${DAYS[di]} ${fmtHr(h)} — ${eur(cell.revenueCents)} · ${cell.orders} orders · ${cell.units} units`}
                      style={{ height: 22, borderRadius: 3, background: heat(v, maxCell), display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 8, color: heatText(v, maxCell), userSelect: 'none' }}>
                      {v > 0 && maxCell > 0 && v / maxCell > 0.66 ? (metric === 'revenue' ? Math.round(v / 100) : v) : ''}
                    </div>
                  )
                })}
              </Fragment>
            ))}
        </div>
      </div>

      {/* empty state */}
      {!loading && data && !data.hasData && (
        <div className="az-empty" style={{ border: '1px solid var(--divider)', borderRadius: 10, marginTop: 12 }}>
          No orders in this slice — widen the date range or clear the market/product filter.
        </div>
      )}

      {/* ── hour-of-day profile ── */}
      {data && data.hasData && <>
        <div style={{ fontWeight: 700, fontSize: 12.5, margin: '18px 2px 8px' }}>Hour-of-day profile <span style={{ fontWeight: 500, color: 'var(--ink3)' }}>· peak ▲ / quiet ▼ vs average</span></div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(24, 1fr)', gap: 3, alignItems: 'end', height: 84, border: '1px solid var(--divider)', borderRadius: 8, padding: '8px 8px 4px', overflowX: 'auto', minWidth: 720 }}>
          {data.hourProfile.map((b) => {
            const v = metricVal(b, metric); const peak = data.peakHours.includes(b.key); const trough = data.troughHours.includes(b.key)
            return (
              <div key={b.key} title={`${fmtHr(b.key)} — ${metricFmt(v, metric)}${b.index != null ? ` · idx ×${b.index.toFixed(2)}` : ''}`} style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'flex-end', height: '100%', gap: 2 }}>
                <span style={{ fontSize: 8, color: peak ? 'var(--green)' : trough ? '#cc1100' : 'transparent', fontWeight: 700, lineHeight: 1 }}>{peak ? '▲' : trough ? '▼' : '·'}</span>
                <div style={{ width: '100%', height: `${Math.max(2, (v / maxHour) * 100)}%`, background: peak ? 'var(--green)' : trough ? '#e7857a' : 'var(--navy)', borderRadius: '2px 2px 0 0', opacity: peak || trough ? 1 : 0.55 }} />
                <span style={{ fontSize: 8, color: 'var(--ink3)' }}>{b.key}</span>
              </div>
            )
          })}
        </div>

        {/* ── weekday profile ── */}
        <div style={{ display: 'flex', gap: 8, marginTop: 12, flexWrap: 'wrap' }}>
          {DOW_ORDER.map((dow, di) => {
            const b = data.weekdayProfile[dow]; const v = metricVal(b, metric)
            return (
              <div key={dow} style={{ flex: 1, minWidth: 84, border: '1px solid var(--divider)', borderRadius: 8, padding: '8px 10px' }}>
                <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--ink2)' }}>{DAYS[di]}</div>
                <div style={{ fontSize: 14, fontWeight: 700 }}>{metricFmt(v, metric)}</div>
                <div style={{ height: 4, borderRadius: 2, background: 'var(--bg2)', marginTop: 5, overflow: 'hidden' }}><div style={{ width: `${(v / maxWd) * 100}%`, height: '100%', background: b.index != null && b.index >= 1.1 ? 'var(--green)' : b.index != null && b.index < 0.7 ? '#e7857a' : 'var(--navy)' }} /></div>
                <div style={{ fontSize: 10, color: 'var(--ink3)', marginTop: 3 }}>{b.index != null ? <span style={{ display: 'inline-flex', alignItems: 'center', gap: 2 }}>{b.index >= 1.1 ? <TrendingUp size={10} /> : b.index < 0.7 ? <TrendingDown size={10} /> : null}idx ×{b.index.toFixed(2)}</span> : '—'}</div>
              </div>
            )
          })}
        </div>
      </>}

      {/* ── DP.4: turn a peak window into an Amazon bid schedule ── */}
      <div style={{ marginTop: 24, borderTop: '1px solid var(--divider)', paddingTop: 16 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', marginBottom: 10 }}>
          <span style={{ fontWeight: 700 }}><Zap size={15} style={{ verticalAlign: 'text-bottom', marginRight: 5, color: 'var(--orange)' }} />Amazon bid schedules</span>
          <span style={{ color: 'var(--ink2)', fontSize: 12 }}>Bid up in your peak hours, ease off in the quiet ones — runs every 15 min in Rome time.</span>
          <span style={{ flex: 1 }} />
          <button className="az-btn dark" onClick={openCreate}><Plus size={14} />Create from peak window</button>
        </div>

        {showCreate && (
          <div className="az-eng-card" style={{ marginBottom: 14 }}>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 12, alignItems: 'start' }}>
              <label style={{ display: 'block' }}>
                <span style={{ fontSize: 11, fontWeight: 700, color: 'var(--ink2)', display: 'block', marginBottom: 4 }}>Campaign {market ? `(${market})` : ''}</span>
                <select value={selCampaign} onChange={(e) => setSelCampaign(e.target.value)} style={{ width: '100%', border: '1px solid var(--border)', borderRadius: 6, padding: '6px 8px', font: 'inherit', cursor: 'pointer' }}>
                  <option value="">{marketCampaigns.length ? 'Select a campaign…' : 'No campaigns in this market'}</option>
                  {marketCampaigns.map((c) => <option key={c.id} value={c.id}>{c.name}{c.marketplace ? ` · ${c.marketplace}` : ''}</option>)}
                </select>
              </label>
              <label style={{ display: 'block' }}>
                <span style={{ fontSize: 11, fontWeight: 700, color: 'var(--ink2)', display: 'block', marginBottom: 4 }}>Name</span>
                <input value={schedName} onChange={(e) => setSchedName(e.target.value)} style={{ width: '100%', border: '1px solid var(--border)', borderRadius: 6, padding: '6px 8px', font: 'inherit' }} />
              </label>
              <div>
                <span style={{ fontSize: 11, fontWeight: 700, color: 'var(--ink2)', display: 'block', marginBottom: 4 }}>Active window (Rome)</span>
                <div style={{ display: 'inline-flex', gap: 4, alignItems: 'center' }}>
                  <select value={win.start} onChange={(e) => setWin({ ...win, start: Number(e.target.value) })} style={{ border: '1px solid var(--border)', borderRadius: 6, padding: '6px 6px', font: 'inherit', cursor: 'pointer' }}>{Array.from({ length: 24 }, (_, h) => <option key={h} value={h}>{fmtHr(h)}</option>)}</select>
                  <span style={{ color: 'var(--ink3)' }}>→</span>
                  <select value={win.end} onChange={(e) => setWin({ ...win, end: Number(e.target.value) })} style={{ border: '1px solid var(--border)', borderRadius: 6, padding: '6px 6px', font: 'inherit', cursor: 'pointer' }}>{Array.from({ length: 24 }, (_, h) => h + 1).map((h) => <option key={h} value={h}>{fmtHr(h === 24 ? 0 : h)}</option>)}</select>
                </div>
              </div>
              <div>
                <span style={{ fontSize: 11, fontWeight: 700, color: 'var(--ink2)', display: 'block', marginBottom: 4 }}>Bid modifier in-window</span>
                <div style={{ display: 'inline-flex', gap: 4 }}>{BID_LADDER.map((m) => <button key={m} className={`az-chip quick ${bidPct === m ? 'on' : ''}`} onClick={() => setBidPct(m)}>{m > 0 ? '+' : ''}{m}%</button>)}</div>
              </div>
            </div>
            <div style={{ marginTop: 10 }}>
              <span style={{ fontSize: 11, fontWeight: 700, color: 'var(--ink2)', display: 'block', marginBottom: 4 }}>Days</span>
              <div style={{ display: 'inline-flex', gap: 4, flexWrap: 'wrap' }}>{DOW_ORDER.map((dow, di) => <button key={dow} className={`az-chip quick ${win.days.includes(dow) ? 'on' : ''}`} onClick={() => toggleDay(dow)}>{DAYS[di]}</button>)}</div>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginTop: 14, flexWrap: 'wrap' }}>
              <button className="az-btn dark" disabled={busy} onClick={() => void createSchedule()}>{busy ? 'Saving…' : 'Create schedule'}</button>
              <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12.5, cursor: 'pointer' }}><input type="checkbox" className="az-check" checked={enableNow} onChange={(e) => setEnableNow(e.target.checked)} />Enable immediately <span style={{ color: 'var(--ink3)' }}>(makes live bid/pause changes)</span></label>
              <button className="az-btn" disabled={busy} onClick={() => { setShowCreate(false); setMsg('') }}>Cancel</button>
              {msg && <span style={{ color: 'var(--ink2)', fontSize: 12 }}>{msg}</span>}
            </div>
          </div>
        )}
        {!showCreate && msg && <div style={{ color: 'var(--ink2)', fontSize: 12, marginBottom: 10 }}>{msg}</div>}

        {schedules.length === 0
          ? <div className="az-empty" style={{ border: '1px solid var(--divider)', borderRadius: 10 }}>No bid schedules yet — create one from a peak window above. They’re created disabled so you can review before going live.</div>
          : schedules.map((s) => {
            const camp = byLocalId[s.campaignId]
            return (
              <div key={s.id} className="az-rule">
                <button className={`az-toggle ${s.enabled ? 'on' : ''}`} disabled={busy} onClick={() => void toggleSched(s)} aria-label="Enable schedule" title={s.enabled ? 'Enabled — applying' : 'Disabled'}><i /></button>
                <div className="nm"><div className="t">{s.name}</div><div className="d2">{camp ? `${camp.name}${camp.marketplace ? ` · ${camp.marketplace}` : ''}` : s.campaignId} · {winSummary(s.windows)}</div></div>
                <span className={`az-live ${s.enabled ? 'on' : 'dry'}`}>{s.enabled ? 'LIVE' : 'Off'}</span>
                {s.lastEvaluatedAt && <div className="stat" title="Last evaluated by the dayparting cron"><b>{s.lastApplied ?? '—'}</b>{new Date(s.lastEvaluatedAt).toLocaleDateString('en-IE')}</div>}
                <button className="az-kebab" disabled={busy} onClick={() => void delSched(s)} title="Delete" style={{ color: '#cc1100' }}><Trash2 size={15} /></button>
              </div>
            )
          })}
      </div>
    </div>
  )
}
