'use client'

/**
 * Shared, dynamic data controls for the analytical automation tabs: a market
 * selector and a date-range control (presets + a custom start/end picker).
 * rangeQuery() turns the selection into the query params the endpoints accept
 * (marketplace + windowDays, or startDate/endDate for custom).
 */

import { Calendar, Globe } from 'lucide-react'

export interface RangeValue { marketplace: string; days: number; start: string; end: string; custom: boolean }
export const DEFAULT_RANGE: RangeValue = { marketplace: 'All', days: 30, start: '', end: '', custom: false }
const MARKETS = ['All', 'IT', 'DE', 'FR', 'ES', 'NL', 'BE', 'SE', 'PL', 'IE', 'UK']
const PRESETS = [7, 14, 30, 60, 90]

export function rangeQuery(v: RangeValue): string {
  const p = new URLSearchParams()
  if (v.custom && v.start && v.end) { p.set('startDate', v.start); p.set('endDate', v.end) } else { p.set('windowDays', String(v.days)) }
  if (v.marketplace && v.marketplace !== 'All') p.set('marketplace', v.marketplace)
  return p.toString()
}
export const rangeLabel = (v: RangeValue) => (v.custom && v.start && v.end ? `${v.start} → ${v.end}` : `Last ${v.days} days`)

export function TabControls({ value, onChange, markets }: { value: RangeValue; onChange: (v: RangeValue) => void; markets?: string[] }) {
  const mkts = markets && markets.length ? ['All', ...markets.filter((m) => m && m !== 'All')] : MARKETS
  const ctl: React.CSSProperties = { border: '1px solid var(--border)', borderRadius: 6, padding: '6px 9px', font: 'inherit', cursor: 'pointer', background: '#fff' }
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, color: 'var(--ink2)', fontSize: 12 }}><Globe size={13} />
        <select value={value.marketplace} onChange={(e) => onChange({ ...value, marketplace: e.target.value })} style={ctl} aria-label="Market">{mkts.map((m) => <option key={m} value={m}>{m === 'All' ? 'All markets' : m}</option>)}</select>
      </span>
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, color: 'var(--ink2)', fontSize: 12 }}><Calendar size={13} />
        <select value={value.custom ? 'custom' : String(value.days)} onChange={(e) => { const v = e.target.value; if (v === 'custom') { const end = new Date().toISOString().slice(0, 10); const s = new Date(Date.now() - 29 * 864e5).toISOString().slice(0, 10); onChange({ ...value, custom: true, start: value.start || s, end: value.end || end }) } else onChange({ ...value, custom: false, days: Number(v) }) }} style={ctl} aria-label="Date range">
          {PRESETS.map((d) => <option key={d} value={d}>Last {d} days</option>)}
          <option value="custom">Custom…</option>
        </select>
      </span>
      {value.custom && <>
        <input type="date" value={value.start} max={value.end || undefined} onChange={(e) => onChange({ ...value, start: e.target.value })} style={{ ...ctl, cursor: 'text' }} aria-label="Start date" />
        <span style={{ color: 'var(--ink3)' }}>→</span>
        <input type="date" value={value.end} min={value.start || undefined} onChange={(e) => onChange({ ...value, end: e.target.value })} style={{ ...ctl, cursor: 'text' }} aria-label="End date" />
      </>}
    </span>
  )
}
