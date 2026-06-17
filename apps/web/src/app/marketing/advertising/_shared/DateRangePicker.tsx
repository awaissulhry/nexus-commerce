'use client'

/**
 * DR.2 — shared date-range control for the advertising console.
 *
 * Amazon-style preset dropdown (Today · Yesterday · Last 7/14/30/90 · Week/
 * Month/Quarter/Year to date · Last month · Last year · Lifetime · Custom) plus
 * a custom start/end calendar. The selection is mirrored to the URL (?preset or
 * ?startDate&endDate) and localStorage so it persists across navigation and is
 * shareable, and exposed via useAdRange() for client-side fetches.
 *
 * Ranges are resolved Rome-anchored on the server (ads-date-range.ts); this
 * component only carries the preset/custom intent.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Calendar, ChevronDown, Check } from 'lucide-react'

export interface AdRange { preset: string; startDate?: string; endDate?: string }

export const RANGE_PRESETS: Array<{ key: string; label: string; group?: string }> = [
  { key: 'today', label: 'Today' },
  { key: 'yesterday', label: 'Yesterday' },
  { key: 'last7', label: 'Last 7 days' },
  { key: 'last14', label: 'Last 14 days' },
  { key: 'last30', label: 'Last 30 days' },
  { key: 'last90', label: 'Last 90 days' },
  { key: 'wtd', label: 'Week to date' },
  { key: 'mtd', label: 'Month to date' },
  { key: 'last_month', label: 'Last month' },
  { key: 'qtd', label: 'Quarter to date' },
  { key: 'ytd', label: 'Year to date' },
  { key: 'last_year', label: 'Last year' },
  { key: 'lifetime', label: 'Lifetime' },
]

const STORAGE_KEY = 'ads.range.v1'
const DEFAULT: AdRange = { preset: 'last7' }

// DR.3 — which presets' windows extend to "now" (today). yesterday / last
// month / last year end before today and are fully settled.
const SETTLED_PRESETS = new Set(['yesterday', 'last_month', 'last_year'])
export function rangeIncludesToday(r: AdRange): boolean {
  if (r.preset === 'custom') return !!r.endDate && r.endDate >= new Date().toISOString().slice(0, 10)
  return !SETTLED_PRESETS.has(r.preset)
}

export function labelFor(r: AdRange): string {
  if (r.preset === 'custom' && r.startDate && r.endDate) {
    const fmt = (s: string) => new Date(s + 'T00:00:00Z').toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' })
    return `${fmt(r.startDate)} – ${fmt(r.endDate)}`
  }
  return RANGE_PRESETS.find((p) => p.key === r.preset)?.label ?? 'Last 7 days'
}

/** Append the active range to a fetch URL as query params. */
export function rangeQuery(r: AdRange): string {
  if (r.preset === 'custom' && r.startDate && r.endDate) {
    return `preset=custom&startDate=${r.startDate}&endDate=${r.endDate}`
  }
  return `preset=${r.preset}`
}

/** Read/write the active range from URL → localStorage → default, mirrored back. */
export function useAdRange(): { range: AdRange; setRange: (r: AdRange) => void } {
  const [range, setRangeState] = useState<AdRange>(DEFAULT)
  useEffect(() => {
    try {
      const u = new URLSearchParams(window.location.search)
      const preset = u.get('preset')
      const sd = u.get('startDate'); const ed = u.get('endDate')
      if (preset === 'custom' && sd && ed) { setRangeState({ preset: 'custom', startDate: sd, endDate: ed }); return }
      if (preset) { setRangeState({ preset }); return }
      const s = localStorage.getItem(STORAGE_KEY)
      if (s) { const v = JSON.parse(s) as AdRange; if (v?.preset) setRangeState(v) }
    } catch { /* default */ }
  }, [])
  const setRange = useCallback((r: AdRange) => {
    setRangeState(r)
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(r)) } catch { /* ignore */ }
    try {
      const url = new URL(window.location.href)
      url.searchParams.delete('startDate'); url.searchParams.delete('endDate'); url.searchParams.delete('windowDays')
      url.searchParams.set('preset', r.preset)
      if (r.preset === 'custom' && r.startDate && r.endDate) { url.searchParams.set('startDate', r.startDate); url.searchParams.set('endDate', r.endDate) }
      window.history.replaceState({}, '', url)
    } catch { /* ignore */ }
  }, [])
  return { range, setRange }
}

export function DateRangePicker({ value, onChange, dataThrough, livePartial }: { value: AdRange; onChange: (r: AdRange) => void; dataThrough?: string | null; livePartial?: boolean }) {
  const [open, setOpen] = useState(false)
  const [customStart, setCustomStart] = useState(value.startDate ?? '')
  const [customEnd, setCustomEnd] = useState(value.endDate ?? '')
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const onDoc = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false) }
    document.addEventListener('mousedown', onDoc)
    return () => document.removeEventListener('mousedown', onDoc)
  }, [open])
  const today = useMemo(() => new Date().toISOString().slice(0, 10), [])
  const applyCustom = () => { if (customStart && customEnd) { onChange({ preset: 'custom', startDate: customStart, endDate: customEnd }); setOpen(false) } }
  const showLive = livePartial ?? rangeIncludesToday(value)

  return (
    <div className="relative inline-flex items-center gap-1.5" ref={ref}>
      {/* DR.3 — the selected range includes today, whose data is live + still
          firming up (intraday Marketing Stream; daily settles T+1). */}
      {showLive && (
        <span title="Includes today — live, still updating (intraday). Earlier days are settled." className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full text-[11px] bg-emerald-50 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300">
          <span className="h-1.5 w-1.5 rounded-full bg-emerald-500 animate-pulse" /> live · partial
        </span>
      )}
      <button onClick={() => setOpen((o) => !o)} aria-haspopup="listbox" aria-expanded={open}
        className="inline-flex items-center gap-1.5 px-2.5 py-1.5 text-sm rounded-md border border-default dark:border-slate-700 bg-white dark:bg-slate-900 hover:bg-slate-50 dark:hover:bg-slate-800">
        <Calendar size={14} className="text-tertiary" />
        <span className="font-medium text-slate-700 dark:text-slate-200">{labelFor(value)}</span>
        <ChevronDown size={14} className="text-tertiary" />
      </button>
      {open && (
        <div role="listbox" className="absolute right-0 z-30 mt-1 w-64 rounded-lg border border-default dark:border-slate-700 bg-white dark:bg-slate-900 shadow-lg p-1">
          <div className="max-h-72 overflow-y-auto">
            {RANGE_PRESETS.map((p) => (
              <button key={p.key} role="option" aria-selected={value.preset === p.key}
                onClick={() => { onChange({ preset: p.key }); setOpen(false) }}
                className={`w-full flex items-center justify-between px-2.5 py-1.5 text-sm rounded-md text-left transition ${value.preset === p.key ? 'bg-blue-50 text-blue-700 dark:bg-blue-950/40 dark:text-blue-300 font-medium' : 'text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800'}`}>
                {p.label}{value.preset === p.key && <Check size={13} />}
              </button>
            ))}
          </div>
          <div className="border-t border-subtle dark:border-slate-800 mt-1 pt-2 px-1.5 pb-1">
            <div className={`text-xs mb-1 ${value.preset === 'custom' ? 'text-blue-700 dark:text-blue-300 font-medium' : 'text-slate-500'}`}>Custom range</div>
            <div className="flex items-center gap-1">
              <input type="date" value={customStart} max={customEnd || today} onChange={(e) => setCustomStart(e.target.value)} aria-label="Start date" className="flex-1 min-w-0 px-1.5 py-1 text-xs rounded border border-default dark:border-slate-700 bg-white dark:bg-slate-900" />
              <span className="text-tertiary text-xs">–</span>
              <input type="date" value={customEnd} min={customStart} max={today} onChange={(e) => setCustomEnd(e.target.value)} aria-label="End date" className="flex-1 min-w-0 px-1.5 py-1 text-xs rounded border border-default dark:border-slate-700 bg-white dark:bg-slate-900" />
            </div>
            <button onClick={applyCustom} disabled={!customStart || !customEnd}
              className="mt-1.5 w-full px-2 py-1 text-xs rounded-md bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-40">Apply</button>
          </div>
          {dataThrough && <div className="px-2.5 pt-1.5 pb-0.5 text-[11px] text-tertiary border-t border-subtle dark:border-slate-800 mt-1">Data through {dataThrough}</div>}
        </div>
      )}
    </div>
  )
}
