'use client'

/**
 * AX.9 — Dayparting schedules: a campaign delivers only inside its day×hour
 * windows; the cron pauses/enables it accordingly. Create/list/toggle.
 */

import { useCallback, useEffect, useState } from 'react'
import { Clock, Trash2, Play } from 'lucide-react'
import { getBackendUrl } from '@/lib/backend-url'

interface Win { days: number[]; startHour: number; endHour: number }
interface Schedule { id: string; campaignId: string; name: string; windows: Win[]; timezone: string; enabled: boolean; lastApplied: string | null }
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

export function DaypartingClient() {
  const [items, setItems] = useState<Schedule[]>([])
  const [creating, setCreating] = useState(false)
  const [campaignId, setCampaignId] = useState('')
  const [name, setName] = useState('')
  const [days, setDays] = useState<number[]>([1, 2, 3, 4, 5])
  const [startHour, setStartHour] = useState('8')
  const [endHour, setEndHour] = useState('22')
  const [result, setResult] = useState<string | null>(null)

  const load = useCallback(async () => {
    const r = await fetch(`${getBackendUrl()}/api/advertising/schedules`, { cache: 'no-store' }).then((x) => x.json()).catch(() => ({ items: [] }))
    setItems(r.items ?? [])
  }, [])
  useEffect(() => { void load() }, [load])

  const create = async () => {
    await fetch(`${getBackendUrl()}/api/advertising/schedules`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ campaignId, name, windows: [{ days, startHour: parseInt(startHour, 10), endHour: parseInt(endHour, 10) }] }) })
    setCreating(false); setCampaignId(''); setName(''); void load()
  }
  const toggle = async (s: Schedule) => { await fetch(`${getBackendUrl()}/api/advertising/schedules/${s.id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled: !s.enabled }) }); void load() }
  const del = async (id: string) => { await fetch(`${getBackendUrl()}/api/advertising/schedules/${id}`, { method: 'DELETE' }); void load() }
  const runNow = async () => { const r = await fetch(`${getBackendUrl()}/api/advertising/dayparting/run-now`, { method: 'POST' }).then((x) => x.json()); setResult(`Evaluated ${r.evaluated}, changed ${r.changed}.`); void load() }

  return (
    <div className="max-w-[1000px]">
      <div className="flex items-center gap-2 mb-1"><Clock size={20} className="text-indigo-500" /><h1 className="text-xl font-semibold text-slate-900 dark:text-slate-100">Dayparting</h1></div>
      <p className="text-sm text-slate-500 dark:text-slate-400 mb-4">Run campaigns only when they convert. A campaign delivers inside its windows and is paused outside them automatically (checked every 15 min).</p>
      <div className="flex gap-2 mb-3">
        <button onClick={() => setCreating(true)} className="px-3 py-1.5 text-sm rounded-md bg-indigo-600 text-white hover:bg-indigo-700">+ New schedule</button>
        <button onClick={runNow} className="inline-flex items-center gap-1 px-3 py-1.5 text-sm rounded-md border border-default dark:border-slate-700 hover:bg-slate-50 dark:hover:bg-slate-800"><Play size={14} /> Run now</button>
        {result && <span className="text-sm text-slate-500 self-center">{result}</span>}
      </div>

      {creating && (
        <div className="rounded-lg border border-default dark:border-slate-800 p-3 mb-3 space-y-2">
          <div className="flex gap-2">
            <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Schedule name" className="flex-1 px-2 py-1.5 text-sm rounded border border-default dark:border-slate-700 bg-white dark:bg-slate-950" />
            <input value={campaignId} onChange={(e) => setCampaignId(e.target.value)} placeholder="Campaign id" className="flex-1 px-2 py-1.5 text-sm rounded border border-default dark:border-slate-700 bg-white dark:bg-slate-950" />
          </div>
          <div className="flex gap-1">{DAYS.map((d, i) => <button key={d} onClick={() => setDays((s) => s.includes(i) ? s.filter((x) => x !== i) : [...s, i])} className={`px-2 py-1 text-xs rounded ${days.includes(i) ? 'bg-indigo-600 text-white' : 'border border-default dark:border-slate-700'}`}>{d}</button>)}</div>
          <div className="flex items-center gap-2 text-sm"><span>Active</span><input value={startHour} onChange={(e) => setStartHour(e.target.value)} className="w-14 px-2 py-1 rounded border border-default dark:border-slate-700 bg-white dark:bg-slate-950" />:00 →<input value={endHour} onChange={(e) => setEndHour(e.target.value)} className="w-14 px-2 py-1 rounded border border-default dark:border-slate-700 bg-white dark:bg-slate-950" />:00 <span className="text-xs text-tertiary">Europe/Rome</span></div>
          <div className="flex gap-2"><button onClick={create} disabled={!name || !campaignId} className="px-3 py-1.5 text-sm rounded bg-indigo-600 text-white disabled:opacity-50">Create</button><button onClick={() => setCreating(false)} className="px-3 py-1.5 text-sm rounded border border-default dark:border-slate-700">Cancel</button></div>
        </div>
      )}

      <div className="rounded-lg border border-default dark:border-slate-800 overflow-hidden">
        <table className="w-full text-sm"><thead className="bg-slate-50 dark:bg-slate-900/60 text-xs text-slate-500"><tr><th className="text-left px-3 py-2">Schedule</th><th className="text-left px-3 py-2">Windows</th><th className="text-center px-3 py-2">Now</th><th className="text-center px-3 py-2">Enabled</th><th className="px-3 py-2"></th></tr></thead>
        <tbody className="divide-y divide-slate-100 dark:divide-slate-800">{items.length === 0 ? <tr><td colSpan={5} className="px-3 py-6 text-center text-tertiary text-xs">No schedules. Create one to dayparting a campaign.</td></tr> : items.map((s) => (
          <tr key={s.id}><td className="px-3 py-1.5"><div className="font-medium">{s.name}</div><div className="text-xs text-tertiary font-mono">{s.campaignId.slice(0, 12)}…</div></td>
          <td className="px-3 py-1.5 text-xs text-slate-500">{(s.windows ?? []).map((w, i) => <div key={i}>{w.days.map((d) => DAYS[d]).join(',')} · {w.startHour}:00–{w.endHour}:00</div>)}</td>
          <td className="px-3 py-1.5 text-center"><span className={`text-xs px-1.5 py-0.5 rounded ${s.lastApplied === 'ENABLED' ? 'bg-emerald-100 text-emerald-700' : s.lastApplied === 'PAUSED' ? 'bg-amber-100 text-amber-700' : 'bg-slate-100 text-slate-500'}`}>{s.lastApplied ?? '—'}</span></td>
          <td className="px-3 py-1.5 text-center"><button onClick={() => toggle(s)} className={`text-xs px-1.5 py-0.5 rounded ${s.enabled ? 'bg-emerald-100 text-emerald-700' : 'bg-slate-100 text-slate-500'}`}>{s.enabled ? 'On' : 'Off'}</button></td>
          <td className="px-3 py-1.5 text-right"><button onClick={() => del(s.id)} className="text-rose-400"><Trash2 size={13} /></button></td></tr>
        ))}</tbody></table>
      </div>
    </div>
  )
}
