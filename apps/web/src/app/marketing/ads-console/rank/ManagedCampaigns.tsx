'use client'

/**
 * RC5.1/5.2 — Managed campaigns. Every campaign Rank Control is running on (its
 * AdSchedule, and in RC5.2 active rules too), with what's running, and the ability
 * to Revert to original (disable the schedule → restore originalBids → resume the
 * campaign — reversible) or Remove it permanently. Market-scoped.
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import { History, Loader2, RotateCcw, Trash2, ExternalLink } from 'lucide-react'
import { getBackendUrl } from '@/lib/backend-url'

interface Sched { id: string; campaignId: string; name: string; windows: Array<{ days?: number[]; startHour?: number; endHour?: number; bidMultiplierPct?: number }>; timezone: string; enabled: boolean }
interface Camp { id: string; name: string; marketplace: string | null; status: string }

export function ManagedCampaigns({ market, onJump, onChanged }: { market: string; onJump: (id: string) => void; onChanged: () => void }) {
  const [scheds, setScheds] = useState<Sched[] | null>(null)
  const [camps, setCamps] = useState<Camp[]>([])
  const [busy, setBusy] = useState<string | null>(null)
  const [msg, setMsg] = useState('')

  const load = useCallback(async (signal?: AbortSignal) => {
    const [s, c] = await Promise.all([
      fetch(`${getBackendUrl()}/api/advertising/schedules`, { cache: 'no-store', signal }).then(r => r.json()).catch(() => ({ items: [] })),
      fetch(`${getBackendUrl()}/api/advertising/campaigns?limit=500`, { cache: 'no-store', signal }).then(r => r.json()).catch(() => ({ items: [] })),
    ])
    if (!signal?.aborted) { setScheds((s.items ?? []) as Sched[]); setCamps((c.items ?? []) as Camp[]) }
  }, [])
  useEffect(() => { const ac = new AbortController(); void load(ac.signal); return () => ac.abort() }, [load])

  const campMap = useMemo(() => new Map(camps.map(c => [c.id, c])), [camps])
  const rows = useMemo(() => (scheds ?? []).map(s => ({ s, c: campMap.get(s.campaignId) })).filter(r => r.c?.marketplace === market), [scheds, campMap, market])

  const revert = useCallback(async (s: Sched) => {
    setBusy(s.id); setMsg('')
    try { await fetch(`${getBackendUrl()}/api/advertising/schedules/${s.id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled: false }) }); setMsg(`Reverted "${campMap.get(s.campaignId)?.name ?? 'campaign'}" — schedule disabled, original bids restored, campaign resumed.`); await load(); onChanged() } catch { setMsg('Could not revert.') }
    setBusy(null)
  }, [campMap, load, onChanged])

  const remove = useCallback(async (s: Sched) => {
    if (!window.confirm(`Remove the rank schedule on "${campMap.get(s.campaignId)?.name ?? 'this campaign'}" permanently?`)) return
    setBusy(s.id); setMsg('')
    try { await fetch(`${getBackendUrl()}/api/advertising/schedules/${s.id}`, { method: 'DELETE' }); setMsg('Schedule removed.'); await load(); onChanged() } catch { setMsg('Could not remove.') }
    setBusy(null)
  }, [campMap, load, onChanged])

  const windowSummary = (w: Sched['windows']) => {
    if (!Array.isArray(w) || w.length === 0) return 'no windows'
    return `${w.length} window${w.length === 1 ? '' : 's'}${w.some(x => x.bidMultiplierPct != null) ? ' · bid-tuned' : ''}`
  }

  return (
    <div className="az-mgd">
      <div className="az-mgd-head"><History size={15} /> <b>Managed campaigns</b> <span className="sub">Rank Control schedules running in {market}</span></div>
      {msg && <div className="az-mgd-msg" role="status" aria-live="polite">{msg}</div>}
      {scheds === null
        ? <div className="az-cockpit-sub">Loading…</div>
        : rows.length === 0
          ? <div className="az-mgd-empty"><History size={16} /> No campaigns are managed by Rank Control in {market} yet. Open the Cockpit and set a schedule to start.</div>
          : <div className="az-mgd-list">
            {rows.map(({ s, c }) => (
              <div key={s.id} className={`az-mgd-row ${s.enabled ? 'on' : 'off'}`}>
                <span className={`st ${s.enabled ? 'live' : 'paused'}`}>{s.enabled ? 'RUNNING' : 'Paused'}</span>
                <span className="nm">{c!.name}</span>
                <span className="wd">{windowSummary(s.windows)} · {s.timezone}</span>
                <span style={{ flex: 1 }} />
                <button type="button" className="az-mini" onClick={() => onJump(s.campaignId)} title="Open this campaign in the cockpit"><ExternalLink size={11} /> Cockpit</button>
                {s.enabled && <button type="button" className="az-mini" disabled={busy === s.id} onClick={() => void revert(s)} title="Disable + restore original bids + resume">{busy === s.id ? <Loader2 size={11} className="az-spin" /> : <RotateCcw size={11} />} Revert</button>}
                <button type="button" className="az-mini danger" disabled={busy === s.id} onClick={() => void remove(s)} title="Remove permanently" aria-label="Remove schedule"><Trash2 size={11} /></button>
              </div>
            ))}
          </div>}
      <div className="az-cockpit-note" style={{ marginTop: 10 }}>Revert disables the schedule, restores the campaign&apos;s original bids, and resumes it — reversible (re-enable from the Cockpit). Remove deletes it permanently.</div>
    </div>
  )
}
