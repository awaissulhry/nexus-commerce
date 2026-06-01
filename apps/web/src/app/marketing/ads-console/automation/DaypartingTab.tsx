'use client'

/**
 * Dayparting — automate bids by time. Shows live day-of-week performance intel
 * (GET /dayparting-intel) with bid-up/keep/bid-down recommendations, plus a
 * 7×24 schedule designer where each hour-of-week carries a bid modifier. Presets
 * (business hours / evenings / weekends-off / always-on). "Run now" fires the
 * engine (POST /dayparting/run-now); the design persists locally + can be saved
 * as a schedule (POST /schedules, best-effort).
 */

import { Fragment, useCallback, useEffect, useMemo, useState } from 'react'
import { Clock, Play, Save, RotateCcw } from 'lucide-react'
import { getBackendUrl } from '@/lib/backend-url'

interface DayIntel { weekday: number; label: string; impressions: number; clicks: number; costCents: number; orders: number; salesCents: number; cvr: number; acos: number | null; cvrIndex: number; recommend: string }
const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']
const MODS = [-50, -25, 0, 25, 50] // bid modifier ladder (%)
const modColor = (m: number) => (m > 25 ? '#067d62' : m > 0 ? '#5aa17f' : m === 0 ? '#eef1f1' : m >= -25 ? '#f3b9b1' : '#e7857a')
const recColor = (r: string) => (r === 'bid-up' ? 'var(--green)' : r === 'bid-down' ? '#cc1100' : 'var(--ink2)')
const STORE = 'ads-console:dayparting:v1'

export function DaypartingTab() {
  const [intel, setIntel] = useState<DayIntel[]>([])
  const [grid, setGrid] = useState<number[][]>(() => Array.from({ length: 7 }, () => Array.from({ length: 24 }, () => 0)))
  const [msg, setMsg] = useState('')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    void fetch(`${getBackendUrl()}/api/advertising/dayparting-intel?windowDays=60`, { cache: 'no-store' }).then((r) => r.json()).then((d) => {
      // intel.days is keyed weekday 0=Sun..6=Sat; remap to Mon-first for display
      const byWd: Record<number, DayIntel> = {}; for (const x of (d.days ?? [])) byWd[x.weekday] = x
      setIntel([1, 2, 3, 4, 5, 6, 0].map((wd) => byWd[wd]).filter(Boolean))
    }).catch(() => {})
    try { const s = localStorage.getItem(STORE); if (s) { const g = JSON.parse(s); if (Array.isArray(g) && g.length === 7) setGrid(g) } } catch { /* ignore */ }
  }, [])

  const persist = useCallback((g: number[][]) => { setGrid(g); try { localStorage.setItem(STORE, JSON.stringify(g)) } catch { /* ignore */ } }, [])
  // drag-to-paint: mousedown cycles a cell + arms the paint value; dragging over
  // cells paints them; a global mouseup disarms.
  const setCell = useCallback((d: number, h: number, v: number) => setGrid((g) => { const ng = g.map((row, di) => di === d ? row.map((x, hi) => hi === h ? v : x) : row); try { localStorage.setItem(STORE, JSON.stringify(ng)) } catch { /* ignore */ } return ng }), [])
  const [paintVal, setPaintVal] = useState<number | null>(null)
  useEffect(() => { const up = () => setPaintVal(null); window.addEventListener('mouseup', up); return () => window.removeEventListener('mouseup', up) }, [])
  const startPaint = (d: number, h: number) => { const next = MODS[(MODS.indexOf(grid[d][h]) + 1) % MODS.length]; setPaintVal(next); setCell(d, h, next) }
  const dragOver = (d: number, h: number) => { if (paintVal !== null) setCell(d, h, paintVal) }
  const preset = (name: string) => {
    const g = Array.from({ length: 7 }, (_, d) => Array.from({ length: 24 }, (_, h) => {
      if (name === 'always') return 0
      if (name === 'business') return d < 5 && h >= 8 && h < 20 ? 25 : -25
      if (name === 'evenings') return h >= 17 && h < 23 ? 25 : (h >= 1 && h < 7 ? -50 : 0)
      if (name === 'weekends-off') return d >= 5 ? -50 : 0
      return 0
    }))
    persist(g)
  }
  const runNow = async () => { setBusy(true); setMsg('Running…'); try { const r = await fetch(`${getBackendUrl()}/api/advertising/dayparting/run-now`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }).then((x) => x.json()).catch(() => null); setMsg(r ? (r.message ?? `Done · ${r.applied ?? r.count ?? 0} adjustment(s)`) : 'Done') } finally { setBusy(false) } }
  const saveSchedule = async () => { setBusy(true); try { const r = await fetch(`${getBackendUrl()}/api/advertising/schedules`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ type: 'DAYPARTING', name: 'Dayparting schedule', grid }) }); setMsg(r.ok ? 'Schedule saved' : 'Saved locally (schedule API pending)') } catch { setMsg('Saved locally') } finally { setBusy(false) } }

  const active = useMemo(() => grid.flat().filter((m) => m !== 0).length, [grid])

  return (
    <div style={{ paddingTop: 4 }}>
      <div style={{ color: 'var(--ink2)', fontSize: 12.5, marginBottom: 12 }}>Bid more when you convert, less when you don’t. Live intel is from your last 60 days; design an hour-of-week bid schedule below.</div>

      {/* weekday intel */}
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 18 }}>
        {intel.map((d) => (
          <div key={d.weekday} className="az-stat" style={{ minWidth: 120, flex: 1 }}>
            <div className="k">{d.label}</div>
            <div className="v" style={{ fontSize: 16 }}>{d.acos != null ? `${(d.acos * 100).toFixed(0)}%` : '—'}<span style={{ fontSize: 11, color: 'var(--ink2)', fontWeight: 500 }}> ACOS</span></div>
            <div className="s">{d.orders} orders · CVR×{d.cvrIndex.toFixed(2)}</div>
            <div style={{ fontWeight: 700, fontSize: 11, color: recColor(d.recommend), marginTop: 3 }}>{d.recommend === 'bid-up' ? '▲ bid up' : d.recommend === 'bid-down' ? '▼ bid down' : '― keep'}</div>
          </div>
        ))}
      </div>

      {/* designer toolbar */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', marginBottom: 10 }}>
        <span style={{ fontWeight: 700 }}><Clock size={15} style={{ verticalAlign: 'text-bottom', marginRight: 5 }} />Hour-of-week bid schedule</span>
        <span style={{ color: 'var(--ink2)', fontSize: 12 }}>{active} of 168 hours modified · click a cell to cycle −50→+50%</span>
        <span style={{ flex: 1 }} />
        {['always', 'business', 'evenings', 'weekends-off'].map((p) => <button key={p} className="az-btn" onClick={() => preset(p)}>{p === 'always' ? 'Always-on' : p === 'business' ? 'Business hrs' : p === 'evenings' ? 'Evenings' : 'Weekends off'}</button>)}
        <button className="az-btn" onClick={() => preset('always')} title="Reset"><RotateCcw size={13} /></button>
      </div>

      {/* 7×24 grid */}
      <div style={{ overflowX: 'auto', border: '1px solid var(--divider)', borderRadius: 8, padding: 8 }}>
        <div style={{ display: 'grid', gridTemplateColumns: `42px repeat(24, 1fr)`, gap: 2, minWidth: 720 }}>
          <span />
          {Array.from({ length: 24 }, (_, h) => <span key={h} style={{ fontSize: 9, color: 'var(--ink3)', textAlign: 'center' }}>{h}</span>)}
          {grid.map((row, d) => (
            <Fragment key={d}>
              <span style={{ fontSize: 11, fontWeight: 600, color: 'var(--ink2)', alignSelf: 'center' }}>{DAYS[d]}</span>
              {row.map((m, h) => (
                <button key={`${d}-${h}`} onMouseDown={(e) => { e.preventDefault(); startPaint(d, h) }} onMouseEnter={() => dragOver(d, h)} draggable={false} title={`${DAYS[d]} ${h}:00 · ${m > 0 ? '+' : ''}${m}% — drag to paint`} style={{ height: 22, border: '1px solid #fff', borderRadius: 3, background: modColor(m), cursor: 'pointer', fontSize: 8, color: Math.abs(m) > 25 ? '#fff' : 'var(--ink2)', padding: 0, userSelect: 'none' }}>{m !== 0 ? (m > 0 ? '+' : '') + m : ''}</button>
              ))}
            </Fragment>
          ))}
        </div>
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 14 }}>
        <button className="az-btn dark" disabled={busy} onClick={() => void saveSchedule()}><Save size={14} />Save schedule</button>
        <button className="az-btn" disabled={busy} onClick={() => void runNow()}><Play size={14} />Run dayparting now</button>
        {msg && <span style={{ color: 'var(--ink2)', fontSize: 12 }}>{msg}</span>}
      </div>
    </div>
  )
}
