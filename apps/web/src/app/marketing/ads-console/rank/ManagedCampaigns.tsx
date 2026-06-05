'use client'

/**
 * RC5.1/5.2 — Managed campaigns. Everything Rank Control runs in this market:
 * per-campaign AdSchedules (RUNNING/Paused, window summary, ACOS) with Revert
 * (disable → restore originalBids → resume, reversible) / Remove / bulk-revert,
 * plus the market's automation rules with enable/disable and an emergency
 * Pause-all (with one-click Resume). Market-scoped.
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import { History, Loader2, RotateCcw, Trash2, ExternalLink, Bot, AlertTriangle, FlaskConical } from 'lucide-react'
import { getBackendUrl } from '@/lib/backend-url'

interface Sched { id: string; campaignId: string; name: string; windows: Array<{ days?: number[]; startHour?: number; endHour?: number; bidMultiplierPct?: number }>; timezone: string; enabled: boolean }
interface Camp { id: string; name: string; marketplace: string | null; status: string; acos: number | null }
interface Rule { id: string; name: string; enabled: boolean; dryRun: boolean; scopeMarketplace: string | null }

const pct = (v: number | null | undefined) => (v == null ? '—' : `${Math.round(v * 100)}%`)

export function ManagedCampaigns({ market, onJump, onChanged }: { market: string; onJump: (id: string) => void; onChanged: () => void }) {
  const [scheds, setScheds] = useState<Sched[] | null>(null)
  const [camps, setCamps] = useState<Camp[]>([])
  const [rules, setRules] = useState<Rule[]>([])
  const [busy, setBusy] = useState<string | null>(null)
  const [msg, setMsg] = useState('')
  const [sel, setSel] = useState<Set<string>>(new Set())
  const [pausedIds, setPausedIds] = useState<string[]>([])

  const load = useCallback(async (signal?: AbortSignal) => {
    const [s, c, r] = await Promise.all([
      fetch(`${getBackendUrl()}/api/advertising/schedules`, { cache: 'no-store', signal }).then(x => x.json()).catch(() => ({ items: [] })),
      fetch(`${getBackendUrl()}/api/advertising/campaigns?limit=500`, { cache: 'no-store', signal }).then(x => x.json()).catch(() => ({ items: [] })),
      fetch(`${getBackendUrl()}/api/advertising/automation-rules`, { cache: 'no-store', signal }).then(x => x.json()).catch(() => ({ items: [] })),
    ])
    if (!signal?.aborted) { setScheds((s.items ?? []) as Sched[]); setCamps((c.items ?? []) as Camp[]); setRules((r.items ?? []) as Rule[]) }
  }, [])
  useEffect(() => { const ac = new AbortController(); void load(ac.signal); return () => ac.abort() }, [load])
  useEffect(() => { setSel(new Set()) }, [market])

  const campMap = useMemo(() => new Map(camps.map(c => [c.id, c])), [camps])
  const rows = useMemo(() => (scheds ?? []).map(s => ({ s, c: campMap.get(s.campaignId) })).filter(r => r.c?.marketplace === market), [scheds, campMap, market])
  const running = rows.filter(r => r.s.enabled)
  const marketRules = useMemo(() => rules.filter(r => r.scopeMarketplace === market || r.scopeMarketplace == null), [rules, market])

  const setSchedEnabled = useCallback(async (ids: string[], enabled: boolean) => {
    for (const id of ids) { try { await fetch(`${getBackendUrl()}/api/advertising/schedules/${id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled }) }) } catch { /* continue */ } }
  }, [])

  const revert = useCallback(async (s: Sched) => {
    setBusy(s.id); setMsg('')
    await setSchedEnabled([s.id], false)
    setMsg(`Reverted "${campMap.get(s.campaignId)?.name ?? 'campaign'}" — disabled, original bids restored, campaign resumed.`)
    await load(); onChanged(); setBusy(null)
  }, [campMap, setSchedEnabled, load, onChanged])

  const revertSelected = useCallback(async () => {
    const ids = running.filter(r => sel.has(r.s.id)).map(r => r.s.id)
    if (!ids.length) return
    setBusy('bulk'); setMsg('')
    await setSchedEnabled(ids, false)
    setMsg(`Reverted ${ids.length} campaign${ids.length === 1 ? '' : 's'} to original.`)
    setSel(new Set()); await load(); onChanged(); setBusy(null)
  }, [running, sel, setSchedEnabled, load, onChanged])

  const remove = useCallback(async (s: Sched) => {
    if (!window.confirm(`Remove the rank schedule on "${campMap.get(s.campaignId)?.name ?? 'this campaign'}" permanently?`)) return
    setBusy(s.id); setMsg('')
    try { await fetch(`${getBackendUrl()}/api/advertising/schedules/${s.id}`, { method: 'DELETE' }); setMsg('Schedule removed.'); await load(); onChanged() } catch { setMsg('Could not remove.') }
    setBusy(null)
  }, [campMap, load, onChanged])

  const toggleRule = useCallback(async (r: Rule) => {
    setBusy(r.id)
    try { await fetch(`${getBackendUrl()}/api/advertising/automation-rules/${r.id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled: !r.enabled }) }); await load(); onChanged() } catch { /* ignore */ }
    setBusy(null)
  }, [load, onChanged])

  const pauseAll = useCallback(async () => {
    if (!window.confirm('Pause ALL advertising automation rules now? (Schedules keep running — revert those individually.)')) return
    setBusy('pauseall'); setMsg('')
    try { const r = await fetch(`${getBackendUrl()}/api/advertising/autonomy/pause-all`, { method: 'POST' }).then(x => x.json()); setPausedIds(r.pausedRuleIds ?? []); setMsg(`Paused ${(r.pausedRuleIds ?? []).length} automation rule(s).`); await load(); onChanged() } catch { setMsg('Could not pause.') }
    setBusy(null)
  }, [load, onChanged])

  const resumeAll = useCallback(async () => {
    if (pausedIds.length === 0) return
    setBusy('pauseall'); setMsg('')
    try { await fetch(`${getBackendUrl()}/api/advertising/autonomy/resume`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ruleIds: pausedIds }) }); setMsg(`Resumed ${pausedIds.length} rule(s).`); setPausedIds([]); await load(); onChanged() } catch { setMsg('Could not resume.') }
    setBusy(null)
  }, [pausedIds, load, onChanged])

  const windowSummary = (w: Sched['windows']) => (!Array.isArray(w) || w.length === 0 ? 'no windows' : `${w.length} window${w.length === 1 ? '' : 's'}${w.some(x => x.bidMultiplierPct != null) ? ' · bid-tuned' : ''}`)

  return (
    <div className="az-mgd">
      <div className="az-mgd-head"><History size={15} /> <b>Managed campaigns</b> <span className="sub">Rank Control in {market} · {running.length} running</span>
        <span style={{ flex: 1 }} />
        {sel.size > 0 && <button type="button" className="az-btn" disabled={busy === 'bulk'} onClick={() => void revertSelected()}>{busy === 'bulk' ? <><Loader2 size={13} className="az-spin" /> …</> : <><RotateCcw size={13} /> Revert {sel.size} selected</>}</button>}
      </div>
      {msg && <div className="az-mgd-msg" role="status" aria-live="polite">{msg}</div>}

      {scheds === null
        ? <div className="az-cockpit-sub">Loading…</div>
        : rows.length === 0
          ? <div className="az-mgd-empty"><History size={16} /> No campaigns are managed by Rank Control in {market} yet. Open the Cockpit and set a schedule to start.</div>
          : <div className="az-mgd-list">
            {rows.map(({ s, c }) => (
              <div key={s.id} className={`az-mgd-row ${s.enabled ? 'on' : 'off'}`}>
                {s.enabled && <input type="checkbox" checked={sel.has(s.id)} onChange={() => setSel(x => { const n = new Set(x); if (n.has(s.id)) n.delete(s.id); else n.add(s.id); return n })} aria-label={`Select ${c!.name}`} />}
                <span className={`st ${s.enabled ? 'live' : 'paused'}`}>{s.enabled ? 'RUNNING' : 'Paused'}</span>
                <span className="nm">{c!.name}</span>
                <span className="wd">{windowSummary(s.windows)} · {s.timezone}</span>
                <span className="res">ACOS {pct(c!.acos)}</span>
                <span style={{ flex: 1 }} />
                <button type="button" className="az-mini" onClick={() => onJump(s.campaignId)} title="Open this campaign in the cockpit"><ExternalLink size={11} /> Cockpit</button>
                {s.enabled && <button type="button" className="az-mini" disabled={busy === s.id} onClick={() => void revert(s)} title="Disable + restore original bids + resume">{busy === s.id ? <Loader2 size={11} className="az-spin" /> : <RotateCcw size={11} />} Revert</button>}
                <button type="button" className="az-mini danger" disabled={busy === s.id} onClick={() => void remove(s)} title="Remove permanently" aria-label="Remove schedule"><Trash2 size={11} /></button>
              </div>
            ))}
          </div>}
      <div className="az-cockpit-note" style={{ marginTop: 10 }}>Revert disables the schedule, restores the campaign&apos;s original bids, and resumes it — reversible (re-enable from the Cockpit). Remove deletes it permanently.</div>

      {/* ── Automation rules running in this market ── */}
      <div className="az-mgd-rules">
        <div className="az-mgd-subhd"><Bot size={14} /> <b>Automation rules</b> <span className="sub">{marketRules.filter(r => r.enabled).length} enabled in {market}</span>
          <span style={{ flex: 1 }} />
          {pausedIds.length > 0
            ? <button type="button" className="az-btn" disabled={busy === 'pauseall'} onClick={() => void resumeAll()}>{busy === 'pauseall' ? <><Loader2 size={13} className="az-spin" /> …</> : <>Resume {pausedIds.length}</>}</button>
            : <button type="button" className="az-btn danger" disabled={busy === 'pauseall' || marketRules.every(r => !r.enabled)} onClick={() => void pauseAll()}>{busy === 'pauseall' ? <><Loader2 size={13} className="az-spin" /> …</> : <><AlertTriangle size={13} /> Pause all rules</>}</button>}
        </div>
        {marketRules.length === 0
          ? <div className="az-cockpit-sub">No automation rules in {market}.</div>
          : marketRules.map(r => (
            <div key={r.id} className="az-mgd-rule">
              <span className={`st ${r.enabled ? (r.dryRun ? 'dry' : 'live') : 'off'}`}>{r.enabled ? (r.dryRun ? 'Dry-run' : 'LIVE') : 'Off'}</span>
              <span className="nm">{r.name}</span>
              {r.scopeMarketplace == null && <span className="mk">account-wide</span>}
              <span style={{ flex: 1 }} />
              {r.dryRun && r.enabled && <FlaskConical size={11} style={{ color: 'var(--ink3)' }} />}
              <button type="button" className="az-mini" disabled={busy === r.id} onClick={() => void toggleRule(r)}>{r.enabled ? 'Disable' : 'Enable'}</button>
            </div>
          ))}
      </div>
    </div>
  )
}
