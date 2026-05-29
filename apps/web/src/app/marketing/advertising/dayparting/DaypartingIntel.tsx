'use client'

/** AX2.11 — Dayparting intelligence: day-of-week conversion heatmap +
 *  recommended delivery windows you can push straight into a schedule. */

import { useCallback, useEffect, useState } from 'react'
import { CalendarClock } from 'lucide-react'
import { getBackendUrl } from '@/lib/backend-url'

interface DayRow { weekday: number; label: string; impressions: number; clicks: number; costCents: number; orders: number; salesCents: number; cvr: number | null; acos: number | null; cvrIndex: number | null; recommend: 'bid-up' | 'keep' | 'bid-down' }
interface Intel { windowDays: number; campaignId: string | null; days: DayRow[]; overallCvr: number | null; recommendedWindows: Array<{ days: number[]; startHour: number; endHour: number }>; note: string }

const pct = (v: number | null, dp = 1) => (v == null ? '—' : `${(v * 100).toFixed(dp)}%`)
const eur = (c: number) => new Intl.NumberFormat('en-IE', { style: 'currency', currency: 'EUR', maximumFractionDigits: 0 }).format(c / 100)
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

function heat(index: number | null): string {
  if (index == null) return 'bg-slate-100 dark:bg-slate-800 text-slate-400'
  if (index >= 1.2) return 'bg-emerald-500 text-white'
  if (index >= 1.0) return 'bg-emerald-200 text-emerald-900 dark:bg-emerald-900/50 dark:text-emerald-200'
  if (index >= 0.6) return 'bg-amber-200 text-amber-900 dark:bg-amber-900/50 dark:text-amber-200'
  return 'bg-rose-300 text-rose-900 dark:bg-rose-900/60 dark:text-rose-200'
}

export function DaypartingIntel({ onCreated }: { onCreated?: () => void }) {
  const [intel, setIntel] = useState<Intel | null>(null)
  const [days, setDays] = useState(60)
  const [loading, setLoading] = useState(false)
  const [campaignId, setCampaignId] = useState('')
  const [msg, setMsg] = useState('')

  const load = useCallback(() => {
    setLoading(true)
    fetch(`${getBackendUrl()}/api/advertising/dayparting-intel?windowDays=${days}${campaignId ? `&campaignId=${campaignId}` : ''}`, { cache: 'no-store' })
      .then((x) => x.json()).then(setIntel).catch(() => {}).finally(() => setLoading(false))
  }, [days, campaignId])
  useEffect(() => { load() }, [load])

  const createSchedule = async () => {
    if (!campaignId) { setMsg('Enter a campaign id to apply'); return }
    if (!intel?.recommendedWindows.length) { setMsg('No window to apply — conversion is even'); return }
    setMsg('…')
    try {
      const r = await fetch(`${getBackendUrl()}/api/advertising/schedules`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ campaignId, name: `Auto dayparting (${days}d)`, windows: intel.recommendedWindows }) }).then((x) => x.json())
      if (r?.error) throw new Error(r.error)
      setMsg('✓ schedule created'); onCreated?.()
    } catch (e) { setMsg((e as Error).message) }
  }

  return (
    <div className="rounded-lg border border-slate-200 dark:border-slate-800 p-4 mb-5">
      <div className="flex items-center gap-2 mb-1"><CalendarClock size={18} className="text-indigo-500" /><h2 className="font-semibold text-slate-900 dark:text-slate-100">When does it convert?</h2>{loading && <span className="text-xs text-slate-400">loading…</span>}</div>
      <p className="text-xs text-slate-500 dark:text-slate-400 mb-3">Conversion rate by day of week (vs your weekly average). Bid up on green days, pause the red ones.{intel?.campaignId ? ` Campaign ${intel.campaignId}.` : ' All campaigns.'}</p>

      <div className="flex flex-wrap items-center gap-2 mb-3">
        <div className="flex gap-1">{[30, 60, 90].map((d) => <button key={d} onClick={() => setDays(d)} className={`px-2.5 py-1 text-xs rounded-md border ${days === d ? 'bg-blue-600 text-white border-blue-600' : 'border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800'}`}>{d}d</button>)}</div>
        <input value={campaignId} onChange={(e) => setCampaignId(e.target.value)} placeholder="Campaign id (optional — filters + apply target)" className="px-2 py-1 text-sm rounded border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950 w-72" />
      </div>

      <div className="grid grid-cols-7 gap-1.5 mb-3">
        {(intel?.days ?? DAYS.map((label, weekday) => ({ weekday, label, cvr: null, cvrIndex: null, orders: 0, costCents: 0, recommend: 'keep' } as Partial<DayRow> as DayRow))).map((d) => (
          <div key={d.weekday} className={`rounded-md px-2 py-2 text-center ${heat(d.cvrIndex)}`}>
            <div className="text-[11px] font-medium">{d.label}</div>
            <div className="text-sm font-semibold tabular-nums">{pct(d.cvr, 1)}</div>
            <div className="text-[10px] opacity-80 tabular-nums">{d.orders} ord · {eur(d.costCents)}</div>
          </div>
        ))}
      </div>

      {intel && (
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <span className="text-xs text-slate-500">{intel.note}</span>
          <button onClick={createSchedule} disabled={!intel.recommendedWindows.length} className="ml-auto px-3 py-1.5 text-sm rounded-md bg-indigo-600 text-white hover:bg-indigo-700 disabled:opacity-40">Apply as schedule</button>
          {msg && <span className={`text-xs ${msg.startsWith('✓') ? 'text-emerald-600' : 'text-slate-500'}`}>{msg}</span>}
        </div>
      )}
    </div>
  )
}
