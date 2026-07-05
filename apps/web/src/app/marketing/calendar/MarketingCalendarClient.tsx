'use client'

/**
 * UM-series (P4) — Marketing calendar client.
 *
 * Dense month grid: RetailEvent background bands (demand anchors) +
 * scheduled-campaign markers (channel-coloured) + operator CalendarEntry
 * pills. Click a day to plan an entry; click an entry to edit/delete.
 * Month nav re-fetches the window; useMarketingEvents live-refreshes.
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import '@/design-system/styles/tokens.css'
import '@/design-system/styles/components.css'
import { ChevronLeft, ChevronRight, Plus, X, CalendarDays, Sparkles } from 'lucide-react'
import { getBackendUrl } from '@/lib/backend-url'
import { useMarketingEvents } from '@/lib/sync/use-marketing-events'
import { Listbox } from '@/design-system/components/Listbox'
import { DateField } from '@/design-system/components/DateField'

interface CalEntry {
  id: string; kind: string; title: string; channel: string | null
  marketplaces: string[]; startsAt: string; endsAt: string | null
  status: string; color: string | null; notes: string | null
  campaignId: string | null; retailEventId: string | null
}
interface RetailBand {
  id: string; name: string; startDate: string; endDate: string
  channel: string | null; marketplace: string | null; expectedLift: number
  prepLeadTimeDays: number; source: string | null
}
interface CalCampaign {
  id: string; name: string; channel: string; surface: string; status: string
  startDate: string; endDate: string | null; marketplaces: string[]; budgetScope: string
}
export interface CalendarData {
  from: string; to: string
  entries: CalEntry[]; retailEvents: RetailBand[]; campaigns: CalCampaign[]
}

const CHANNEL_DOT: Record<string, string> = {
  AMAZON: 'bg-amber-500', EBAY: 'bg-blue-500', SHOPIFY: 'bg-emerald-500',
  GOOGLE: 'bg-sky-500', META: 'bg-indigo-500', TIKTOK: 'bg-fuchsia-500', INTERNAL: 'bg-slate-400',
}
const KIND_PILL: Record<string, string> = {
  CAMPAIGN: 'bg-blue-100 text-blue-700 dark:bg-blue-950/50 dark:text-blue-300',
  DEAL: 'bg-rose-100 text-rose-700 dark:bg-rose-950/50 dark:text-rose-300',
  CONTENT_DROP: 'bg-violet-100 text-violet-700 dark:bg-violet-950/50 dark:text-violet-300',
  OUTREACH: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-950/50 dark:text-emerald-300',
  MILESTONE: 'bg-amber-100 text-amber-700 dark:bg-amber-950/50 dark:text-amber-300',
  NOTE: 'bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300',
}
const KINDS = ['CAMPAIGN', 'DEAL', 'CONTENT_DROP', 'OUTREACH', 'MILESTONE', 'NOTE']
const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']

const ymd = (d: Date) => d.toISOString().slice(0, 10)
function inRange(startISO: string, endISO: string | null, day: Date): boolean {
  const s = startISO.slice(0, 10)
  const e = (endISO ?? startISO).slice(0, 10)
  const k = ymd(day)
  return k >= s && k <= e
}

// Build a Monday-first 6-week grid covering the given month.
function monthGrid(year: number, month: number): Date[] {
  const first = new Date(Date.UTC(year, month, 1))
  const offset = (first.getUTCDay() + 6) % 7 // Mon=0
  const start = new Date(first)
  start.setUTCDate(first.getUTCDate() - offset)
  return Array.from({ length: 42 }, (_, i) => {
    const d = new Date(start)
    d.setUTCDate(start.getUTCDate() + i)
    return d
  })
}

export function MarketingCalendarClient({ initial }: { initial: CalendarData }) {
  const today = new Date()
  const [year, setYear] = useState(today.getUTCFullYear())
  const [month, setMonth] = useState(today.getUTCMonth())
  const [data, setData] = useState<CalendarData>(initial)
  const [loading, setLoading] = useState(false)
  const [editing, setEditing] = useState<Partial<CalEntry> | null>(null)

  const grid = useMemo(() => monthGrid(year, month), [year, month])

  const refetch = useCallback(async () => {
    setLoading(true)
    try {
      const from = ymd(grid[0]!)
      const to = ymd(grid[grid.length - 1]!)
      const res = await fetch(`${getBackendUrl()}/api/marketing/os/calendar?from=${from}&to=${to}`, { cache: 'no-store' })
      if (res.ok) setData(await res.json())
    } catch {
      // keep last good
    } finally {
      setLoading(false)
    }
  }, [grid])

  useEffect(() => {
    void refetch()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [year, month])

  useMarketingEvents(useCallback(() => void refetch(), [refetch]))

  const monthLabel = new Date(Date.UTC(year, month, 1)).toLocaleString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' })
  const go = (delta: number) => {
    const m = month + delta
    if (m < 0) { setMonth(11); setYear((y) => y - 1) }
    else if (m > 11) { setMonth(0); setYear((y) => y + 1) }
    else setMonth(m)
  }

  const saveEntry = async () => {
    if (!editing?.title || !editing?.startsAt) return
    const isNew = !editing.id
    const url = `${getBackendUrl()}/api/marketing/os/calendar${isNew ? '' : `/${editing.id}`}`
    await fetch(url, {
      method: isNew ? 'POST' : 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(editing),
    })
    setEditing(null)
    void refetch()
  }
  const deleteEntry = async (id: string) => {
    await fetch(`${getBackendUrl()}/api/marketing/os/calendar/${id}`, { method: 'DELETE' })
    setEditing(null)
    void refetch()
  }

  return (
    <div className="p-4 sm:p-6 max-w-[1400px] mx-auto">
      <header className="flex flex-wrap items-center gap-3 mb-4">
        <div className="flex items-center gap-2">
          <CalendarDays size={20} className="text-slate-500" />
          <h1 className="text-xl font-semibold text-slate-900 dark:text-slate-100">Marketing calendar</h1>
        </div>
        <div className="flex items-center gap-1 ml-2">
          <button onClick={() => go(-1)} className="p-1.5 rounded hover:bg-slate-100 dark:hover:bg-slate-800"><ChevronLeft size={16} /></button>
          <span className="min-w-[150px] text-center font-medium text-slate-700 dark:text-slate-200">{monthLabel}</span>
          <button onClick={() => go(1)} className="p-1.5 rounded hover:bg-slate-100 dark:hover:bg-slate-800"><ChevronRight size={16} /></button>
          <button onClick={() => { setYear(today.getUTCFullYear()); setMonth(today.getUTCMonth()) }} className="ml-1 px-2 py-1 text-xs rounded border border-default dark:border-slate-700 hover:bg-slate-50 dark:hover:bg-slate-800">Today</button>
        </div>
        <button
          onClick={() => setEditing({ kind: 'NOTE', title: '', startsAt: ymd(today), status: 'PLANNED' })}
          className="ml-auto inline-flex items-center gap-1 px-3 py-1.5 text-sm rounded-md bg-blue-600 text-white hover:bg-blue-700"
        >
          <Plus size={14} /> Add entry
        </button>
        {loading && <span className="text-xs text-tertiary">updating…</span>}
      </header>

      {/* Legend */}
      <div className="flex flex-wrap items-center gap-3 mb-2 text-xs text-slate-500">
        <span className="inline-flex items-center gap-1"><Sparkles size={12} className="text-amber-500" /> Retail event (demand band)</span>
        {Object.entries(CHANNEL_DOT).slice(0, 4).map(([ch, cls]) => (
          <span key={ch} className="inline-flex items-center gap-1"><span className={`w-2 h-2 rounded-full ${cls}`} /> {ch}</span>
        ))}
      </div>

      <div className="grid grid-cols-7 gap-px bg-slate-200 dark:bg-slate-800 rounded-lg overflow-hidden border border-default dark:border-slate-800">
        {WEEKDAYS.map((w) => (
          <div key={w} className="bg-slate-50 dark:bg-slate-900 px-2 py-1.5 text-xs font-medium text-slate-500 text-center">{w}</div>
        ))}
        {grid.map((day) => {
          const inMonth = day.getUTCMonth() === month
          const isToday = ymd(day) === ymd(today)
          const bands = data.retailEvents.filter((e) => inRange(e.startDate, e.endDate, day))
          const dayCampaigns = data.campaigns.filter((c) => inRange(c.startDate, c.endDate, day))
          const dayEntries = data.entries.filter((e) => inRange(e.startsAt, e.endsAt, day))
          return (
            <div
              key={ymd(day)}
              className={`min-h-[104px] p-1.5 text-left align-top relative ${inMonth ? 'bg-white dark:bg-slate-950' : 'bg-slate-50/60 dark:bg-slate-900/40'} hover:bg-blue-50/40 dark:hover:bg-blue-950/20 cursor-pointer`}
              onClick={() => setEditing({ kind: 'NOTE', title: '', startsAt: ymd(day), status: 'PLANNED' })}
            >
              {/* Retail event band tint */}
              {bands.length > 0 && (
                <div className="absolute inset-x-0 top-0 h-1 bg-gradient-to-r from-amber-400 to-orange-400" title={bands.map((b) => `${b.name} (×${b.expectedLift})`).join(', ')} />
              )}
              <div className="flex items-center justify-between">
                <span className={`text-xs font-medium ${isToday ? 'bg-blue-600 text-white rounded-full w-5 h-5 inline-flex items-center justify-center' : inMonth ? 'text-slate-700 dark:text-slate-300' : 'text-tertiary'}`}>{day.getUTCDate()}</span>
                {dayCampaigns.length > 0 && (
                  <span className="flex gap-0.5">
                    {[...new Set(dayCampaigns.map((c) => c.channel))].slice(0, 4).map((ch) => (
                      <span key={ch} className={`w-1.5 h-1.5 rounded-full ${CHANNEL_DOT[ch] ?? CHANNEL_DOT.INTERNAL}`} />
                    ))}
                  </span>
                )}
              </div>
              {bands.map((b) => (
                <div key={b.id} className="mt-0.5 truncate text-[10px] text-amber-700 dark:text-amber-400 font-medium" title={`${b.name} · expected ×${b.expectedLift} lift`}>★ {b.name}</div>
              ))}
              <div className="mt-0.5 space-y-0.5">
                {dayEntries.slice(0, 3).map((e) => (
                  <button
                    key={e.id}
                    onClick={(ev) => { ev.stopPropagation(); setEditing({ ...e, startsAt: e.startsAt.slice(0, 10), endsAt: e.endsAt?.slice(0, 10) ?? null }) }}
                    className={`block w-full text-left truncate px-1 py-0.5 rounded text-[10px] ${KIND_PILL[e.kind] ?? KIND_PILL.NOTE}`}
                    style={e.color ? { backgroundColor: e.color, color: '#fff' } : undefined}
                    title={e.title}
                  >
                    {e.title}
                  </button>
                ))}
                {dayCampaigns.slice(0, 2).map((c) => (
                  <div key={c.id} className="truncate px-1 text-[10px] text-slate-500 dark:text-slate-400" title={`${c.name} · ${c.channel}/${c.surface} · ${c.status}`}>
                    <span className={`inline-block w-1.5 h-1.5 rounded-full mr-1 ${CHANNEL_DOT[c.channel] ?? CHANNEL_DOT.INTERNAL}`} />{c.name}
                  </div>
                ))}
                {dayEntries.length > 3 && <div className="text-[10px] text-tertiary">+{dayEntries.length - 3} more</div>}
              </div>
            </div>
          )
        })}
      </div>

      {/* Create/edit modal */}
      {editing && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={() => setEditing(null)}>
          <div className="bg-white dark:bg-slate-900 rounded-lg shadow-xl w-full max-w-md p-4" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-3">
              <h2 className="font-semibold text-slate-900 dark:text-slate-100">{editing.id ? 'Edit entry' : 'Plan calendar entry'}</h2>
              <button onClick={() => setEditing(null)} className="p-1 rounded hover:bg-slate-100 dark:hover:bg-slate-800"><X size={16} /></button>
            </div>
            <div className="space-y-3">
              <input
                autoFocus value={editing.title ?? ''} onChange={(e) => setEditing({ ...editing, title: e.target.value })}
                placeholder="Title (e.g. Black Friday push)"
                className="w-full px-2 py-1.5 text-sm rounded border border-default dark:border-slate-700 bg-white dark:bg-slate-950"
              />
              <div className="flex gap-2">
                <Listbox value={editing.kind ?? 'NOTE'} onChange={(v) => setEditing({ ...editing, kind: v })} ariaLabel="Entry kind" className="flex-1" options={KINDS.map((k) => ({ value: k, label: k }))} />
                <input type="color" value={editing.color ?? '#3b82f6'} onChange={(e) => setEditing({ ...editing, color: e.target.value })} className="w-10 h-9 rounded border border-default dark:border-slate-700" title="Band color" />
              </div>
              <div className="flex gap-2">
                <label className="flex-1 text-xs text-slate-500">Starts<DateField value={(editing.startsAt ?? '').slice(0, 10)} onChange={(v) => setEditing({ ...editing, startsAt: v })} ariaLabel="Starts" className="w-full mt-0.5" /></label>
                <label className="flex-1 text-xs text-slate-500">Ends (optional)<DateField value={(editing.endsAt ?? '').slice(0, 10)} onChange={(v) => setEditing({ ...editing, endsAt: v || null })} ariaLabel="Ends (optional)" className="w-full mt-0.5" /></label>
              </div>
              <textarea value={editing.notes ?? ''} onChange={(e) => setEditing({ ...editing, notes: e.target.value })} placeholder="Notes" rows={2} className="w-full px-2 py-1.5 text-sm rounded border border-default dark:border-slate-700 bg-white dark:bg-slate-950" />
            </div>
            <div className="flex items-center justify-between mt-4">
              {editing.id ? <button onClick={() => deleteEntry(editing.id!)} className="text-sm text-rose-600 hover:underline">Delete</button> : <span />}
              <div className="flex gap-2">
                <button onClick={() => setEditing(null)} className="px-3 py-1.5 text-sm rounded border border-default dark:border-slate-700">Cancel</button>
                <button onClick={saveEntry} disabled={!editing.title || !editing.startsAt} className="px-3 py-1.5 text-sm rounded bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50">{editing.id ? 'Save' : 'Create'}</button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
