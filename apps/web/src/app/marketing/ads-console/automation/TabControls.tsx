'use client'

/**
 * Shared, dynamic data controls for the analytical automation tabs: a market
 * selector and a date-range control (presets + a custom start/end picker).
 * rangeQuery() turns the selection into the query params the endpoints accept
 * (marketplace + windowDays, or startDate/endDate for custom).
 */

import { Calendar, Globe } from 'lucide-react'
import { Listbox } from '@/design-system/components/Listbox'
import { DateField } from '@/design-system/components/DateField'

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
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, color: 'var(--ink2)', fontSize: 12 }}><Globe size={13} />
        <Listbox ariaLabel="Market" width={140} value={value.marketplace} onChange={(m) => onChange({ ...value, marketplace: m })} options={mkts.map((m) => ({ value: m, label: m === 'All' ? 'All markets' : m }))} />
      </span>
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, color: 'var(--ink2)', fontSize: 12 }}><Calendar size={13} />
        <Listbox
          ariaLabel="Date range"
          width={150}
          value={value.custom ? 'custom' : String(value.days)}
          onChange={(v) => { if (v === 'custom') { const end = new Date().toISOString().slice(0, 10); const s = new Date(Date.now() - 29 * 864e5).toISOString().slice(0, 10); onChange({ ...value, custom: true, start: value.start || s, end: value.end || end }) } else onChange({ ...value, custom: false, days: Number(v) }) }}
          options={[...PRESETS.map((d) => ({ value: String(d), label: `Last ${d} days` })), { value: 'custom', label: 'Custom…' }]}
        />
      </span>
      {value.custom && <>
        <DateField ariaLabel="Start date" value={value.start} max={value.end || undefined} clearable={false} onChange={(v) => onChange({ ...value, start: v })} />
        <span style={{ color: 'var(--ink3)' }}>→</span>
        <DateField ariaLabel="End date" value={value.end} min={value.start || undefined} clearable={false} onChange={(v) => onChange({ ...value, end: v })} />
      </>}
    </span>
  )
}
