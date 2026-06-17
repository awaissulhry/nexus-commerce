'use client'

/** AX3.14 — Advertising Events: unified change timeline (operator +
 *  automation + system) with custom annotations. */

import { useCallback, useEffect, useState } from 'react'
import { History, Plus } from 'lucide-react'
import { getBackendUrl } from '@/lib/backend-url'

interface AdEvent { id: string; time: string; eventType: string; changeResult: string; source: 'Operator' | 'Automation' | 'System'; affectLevel: string; entityId: string; user: string | null; status: string | null; rolledBack: boolean }

const SOURCE_CHIP: Record<string, string> = {
  Operator: 'bg-blue-100 text-blue-700 dark:bg-blue-950/50 dark:text-blue-300',
  Automation: 'bg-violet-100 text-violet-700 dark:bg-violet-950/50 dark:text-violet-300',
  System: 'bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300',
}

export function EventsClient() {
  const [events, setEvents] = useState<AdEvent[]>([])
  const [loading, setLoading] = useState(false)
  const [source, setSource] = useState('')
  const [note, setNote] = useState('')
  const [adding, setAdding] = useState(false)

  const load = useCallback(() => {
    setLoading(true)
    fetch(`${getBackendUrl()}/api/advertising/events?limit=300${source ? `&source=${source}` : ''}`, { cache: 'no-store' }).then((x) => x.json()).then((r) => setEvents(r.events ?? [])).catch(() => {}).finally(() => setLoading(false))
  }, [source])
  useEffect(() => { load() }, [load])

  const addCustom = async () => {
    if (!note.trim()) return
    setAdding(true)
    try { await fetch(`${getBackendUrl()}/api/advertising/events/custom`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ note: note.trim() }) }); setNote(''); load() }
    finally { setAdding(false) }
  }

  return (
    <div className="max-w-[1100px]">
      <div className="flex items-center gap-2 mb-1"><History size={20} className="text-slate-500" /><h1 className="text-xl font-semibold text-slate-900 dark:text-slate-100">Advertising events</h1></div>
      <p className="text-sm text-slate-500 dark:text-slate-400 mb-4">Every change to the account on one timeline — what changed, who or what triggered it, and the outcome. Annotate with custom events for context.{loading ? ' (loading…)' : ''}</p>

      <div className="flex flex-wrap items-center gap-2 mb-3">
        <div className="inline-flex rounded-md border border-default dark:border-slate-700 overflow-hidden">
          {[['', 'All'], ['Operator', 'Operator'], ['Automation', 'Automation'], ['System', 'System']].map(([v, label]) => (
            <button key={v} onClick={() => setSource(v)} className={`px-2.5 py-1.5 text-xs border-l first:border-l-0 border-default dark:border-slate-700 ${source === v ? 'bg-slate-900 text-white dark:bg-slate-700' : 'text-slate-600 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800'}`}>{label}</button>
          ))}
        </div>
        <div className="ml-auto inline-flex items-center gap-1">
          <input value={note} onChange={(e) => setNote(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') addCustom() }} placeholder="Add a custom event…" className="px-2 py-1.5 text-sm rounded-md border border-default dark:border-slate-700 bg-white dark:bg-slate-900 w-56" />
          <button onClick={addCustom} disabled={adding || !note.trim()} className="inline-flex items-center gap-1 px-3 py-1.5 text-sm rounded-md bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50"><Plus size={14} /> Add</button>
        </div>
      </div>

      <div className="rounded-lg border border-default dark:border-slate-800 overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-slate-50 dark:bg-slate-900/60 text-xs text-slate-500"><tr><th className="text-left px-3 py-2">Time</th><th className="text-left px-3 py-2">Event</th><th className="text-left px-3 py-2">Change</th><th className="text-left px-3 py-2">Source</th><th className="text-left px-3 py-2">Level</th><th className="text-left px-3 py-2">By</th><th className="text-left px-3 py-2">Status</th></tr></thead>
          <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
            {events.length === 0 && !loading && <tr><td colSpan={7} className="px-3 py-8 text-center text-tertiary text-xs">No events yet.</td></tr>}
            {events.map((e) => (
              <tr key={e.id} className={`hover:bg-slate-50 dark:hover:bg-slate-900/40 ${e.rolledBack ? 'opacity-50 line-through' : ''}`}>
                <td className="px-3 py-1.5 text-xs text-tertiary whitespace-nowrap">{new Date(e.time).toLocaleString()}</td>
                <td className="px-3 py-1.5">{e.eventType.replace(/_/g, ' ')}</td>
                <td className="px-3 py-1.5 text-slate-600 dark:text-slate-300">{e.changeResult}</td>
                <td className="px-3 py-1.5"><span className={`px-1.5 py-0.5 rounded text-[11px] ${SOURCE_CHIP[e.source]}`}>{e.source}</span></td>
                <td className="px-3 py-1.5 text-xs text-slate-500">{e.affectLevel}</td>
                <td className="px-3 py-1.5 text-xs text-slate-500">{e.user ?? '—'}</td>
                <td className="px-3 py-1.5 text-xs">{e.rolledBack ? <span className="text-tertiary">reverted</span> : e.status === 'SUCCESS' ? <span className="text-emerald-600">ok</span> : e.status === 'FAILED' ? <span className="text-rose-600">failed</span> : <span className="text-tertiary">{e.status?.toLowerCase() ?? '—'}</span>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}
