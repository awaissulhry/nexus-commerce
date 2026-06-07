'use client'

/**
 * RS.2 — Rank Plan authoring (the first visible surface for the RS rank-defend
 * engine). Per campaign: pick a BASELINE rank target ("for the rest, hold Y"),
 * assign targets to time windows ("Mon–Fri 18–22 → Own Top"), and Save / Publish
 * / Discard. Save persists the schedule (windows + defaultTargetKey) to our DB;
 * Publish arms + runs the defend loop now (gated — sandbox stays local); Discard
 * reverts to the saved state. Shows the live defend decision so you see what the
 * loop would do right now.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { Crosshair, Plus, Trash2, Save, UploadCloud, Undo2, Sparkles, Power, Wand2 } from 'lucide-react'
import { getBackendUrl } from '@/lib/backend-url'
import { DemandReadout, type DemandProfile, type DemandCell } from './DemandReadout'
import { RankTimeGrid } from './RankTimeGrid'
import { RankTargetEditor } from './RankTargetEditor'
import { RankTemplateModal } from './RankTemplateModal'
import { DeliveryChip } from './DeliveryChip'

interface RankTarget { id: string; key: string; name: string; placement: string; targetISPct: number | null; acosCapPct: number | null; pause: boolean; allOut: boolean; color: string | null }
interface Win { days: number[]; startHour: number; endHour: number; targetKey?: string }
interface Sched { id: string; campaignId: string; name: string; windows: Win[]; timezone: string; enabled: boolean; defaultTargetKey?: string | null; targetOverrides?: Record<string, { biasPct?: number; targetISPct?: number; acosCapPct?: number; maxCpcCents?: number }> }
interface Decision { action: string; reason: string; currentPct: number; nextPct: number; achievedISPct: number | null; lossDetected: boolean; lanes?: Array<{ placement: string; fromPct: number; toPct: number; action: string }>; baseBid?: { mode: string; valueCents?: number | null } | null }
const SHORT_PL: Record<string, string> = { PLACEMENT_TOP: 'Top', PLACEMENT_REST_OF_SEARCH: 'Rest', PLACEMENT_PRODUCT_PAGE: 'Product' } // BL.8

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const hh = (h: number) => `${String(h).padStart(2, '0')}:00`
const api = (p: string) => `${getBackendUrl()}/api/advertising${p}`

export function RankPlanPanel({ campaignId, campaignName, onAutoDefend, reloadSignal }: { campaignId: string; campaignName: string; onAutoDefend?: (info: { enabled: boolean; scheduleId: string | null }) => void; reloadSignal?: number }) {
  const [targets, setTargets] = useState<RankTarget[]>([])
  const [sched, setSched] = useState<Sched | null>(null)        // the persisted schedule (or null)
  const [baseline, setBaseline] = useState<string>('')          // working draft: defaultTargetKey
  const [windows, setWindows] = useState<Win[]>([])             // working draft: target windows
  const [loaded, setLoaded] = useState(false)
  const [busy, setBusy] = useState<'' | 'save' | 'publish'>('')
  const [msg, setMsg] = useState('')
  const [decision, setDecision] = useState<Decision | null>(null)
  // RD.10b — the product family's by-hour demand, so you set rank windows where the
  // product actually sells (same fusion as the By-product view, scoped to this campaign).
  const [demand, setDemand] = useState<{ grid: DemandCell[][]; hourProfile: DemandProfile[]; weekdayProfile: DemandProfile[]; hasData: boolean; familyOrders: number; timezone?: string; metric?: 'revenue' | 'orders' } | null>(null)
  const [famName, setFamName] = useState<string>('')
  const [demandDays, setDemandDays] = useState(180) // chosen timeframe for the heatmap data
  const [rec, setRec] = useState<{ windows: Win[]; baselineTargetKey: string; peakHours: number[] } | null>(null)
  const [smoothed, setSmoothed] = useState<{ grid: DemandCell[][]; hourProfile: DemandProfile[]; weekdayProfile: DemandProfile[] } | null>(null)
  const [smooth, setSmooth] = useState(false) // false = RAW actual sales (default); true = market-smoothed
  const [winView, setWinView] = useState<'grid' | 'list'>('grid') // RG.3 — paint grid (default) vs precise list
  const [editorOpen, setEditorOpen] = useState(false) // RTC — rank-target customizer modal
  const [tplOpen, setTplOpen] = useState(false) // RTPL — schedule-templates modal

  // server snapshot for dirty + discard
  const [serverBaseline, setServerBaseline] = useState('')
  const [serverWindows, setServerWindows] = useState<Win[]>([])

  // CR.3b — keep onAutoDefend in a ref so `load` doesn't depend on it. The parent
  // passes a fresh callback each render; depending on it would re-create `load` every
  // render and infinite-loop the load effect (the "glitchy" constant refetch).
  const onAutoDefendRef = useRef(onAutoDefend)
  useEffect(() => { onAutoDefendRef.current = onAutoDefend }, [onAutoDefend])

  const load = useCallback(async () => {
    setLoaded(false)
    const [ts, ss] = await Promise.all([
      fetch(api(`/rank-targets?campaignId=${campaignId}`), { cache: 'no-store' }).then(r => r.json()).catch(() => ({ items: [] })),
      fetch(api('/schedules'), { cache: 'no-store' }).then(r => r.json()).catch(() => ({ items: [] })),
    ])
    setTargets(ts.items ?? [])
    const mine: Sched | null = (ss.items ?? []).find((s: Sched) => s.campaignId === campaignId) ?? null
    setSched(mine)
    const bk = mine?.defaultTargetKey ?? ''
    const wins = (mine?.windows ?? []).filter((w: Win) => w?.targetKey)
    setBaseline(bk); setServerBaseline(bk)
    setWindows(wins.map(w => ({ ...w }))); setServerWindows(wins.map(w => ({ ...w })))
    // CR.3b — tell the cockpit whether auto-defend owns the Top-of-Search dial right now.
    onAutoDefendRef.current?.({ enabled: !!mine?.enabled && (!!bk || wins.length > 0), scheduleId: mine?.id ?? null })
    setLoaded(true)
  }, [campaignId])
  useEffect(() => { void load() }, [load, reloadSignal])

  // live "what would the loop do right now" — only meaningful once a goal exists
  useEffect(() => {
    if (!campaignId || (!serverBaseline && serverWindows.length === 0)) { setDecision(null); return }
    void fetch(api('/rank-defend/run-now?dryRun=1'), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })
      .then(r => r.json()).then(d => setDecision((d.decisions ?? []).find((x: { campaignId: string }) => x.campaignId === campaignId) ?? null)).catch(() => {})
  }, [campaignId, serverBaseline, serverWindows])

  // RD.10b/c — family demand for this campaign's product over the chosen timeframe
  // (the dayparting heatmap) + a recommended set of rank windows from that demand.
  useEffect(() => {
    if (!campaignId) { setDemand(null); setFamName(''); setRec(null); setSmoothed(null); return }
    void fetch(api(`/campaigns/${campaignId}/product-dayparting?windowDays=${demandDays}`), { cache: 'no-store' })
      .then(r => r.json()).then(d => { setDemand(d.demand ?? null); setSmoothed(d.smoothed ?? null); setFamName(d.parentName ?? ''); setRec(d.recommended ?? null) }).catch(() => { setDemand(null) })
  }, [campaignId, demandDays])
  const applyRecommended = () => { if (!rec) return; setWindows(rec.windows.map(w => ({ ...w }))); if (rec.baselineTargetKey) setBaseline(rec.baselineTargetKey) }

  const dirty = baseline !== serverBaseline || JSON.stringify(windows) !== JSON.stringify(serverWindows)

  const addWindow = () => setWindows(w => [...w, { days: [1, 2, 3, 4, 5], startHour: 18, endHour: 22, targetKey: targets[0]?.key }])
  const setWin = (i: number, patch: Partial<Win>) => setWindows(w => w.map((x, j) => j === i ? { ...x, ...patch } : x))
  const removeWin = (i: number) => setWindows(w => w.filter((_, j) => j !== i))
  const toggleDay = (i: number, d: number) => setWindows(w => w.map((x, j) => j === i ? { ...x, days: x.days.includes(d) ? x.days.filter(y => y !== d) : [...x.days, d].sort() } : x))

  const persist = async (): Promise<Sched | null> => {
    const body = { defaultTargetKey: baseline || null, windows }
    if (sched) {
      const r = await fetch(api(`/schedules/${sched.id}`), { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then(x => x.json())
      return r
    }
    const r = await fetch(api('/schedules'), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ campaignId, name: `Rank plan — ${campaignName}`, timezone: 'Europe/Rome', enabled: true, ...body }) }).then(x => x.json())
    return r
  }
  const save = async () => {
    setBusy('save'); setMsg('')
    try { const s = await persist(); if (s?.id) { setSched(s); setServerBaseline(baseline); setServerWindows(windows.map(w => ({ ...w }))); setMsg('Saved — your rank plan is stored. Publish to push it to Amazon (gated).') } else setMsg('Could not save — try again.') } finally { setBusy('') }
  }
  const publish = async () => {
    setBusy('publish'); setMsg('')
    try {
      if (dirty) { const s = await persist(); if (s?.id) { setSched(s); setServerBaseline(baseline); setServerWindows(windows.map(w => ({ ...w }))) } }
      const r = await fetch(api('/rank-defend/run-now'), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }).then(x => x.json()).catch(() => null)
      const mine = (r?.decisions ?? []).find((x: { campaignId: string }) => x.campaignId === campaignId)
      setDecision(mine ?? null)
      setMsg(r ? `Published — defend loop ran (${r.applied ?? 0} change${r.applied === 1 ? '' : 's'} applied; live pushes honour the write-gate).` : 'Publish ran.')
    } finally { setBusy('') }
  }
  const discard = () => { setBaseline(serverBaseline); setWindows(serverWindows.map(w => ({ ...w }))); setMsg('') }
  // CR.3 — §2 owns the goal AND whether the engine auto-holds it (the schedule's
  // enabled flag). Advanced custom rules live separately under §4.
  const toggleDefend = async () => {
    if (!sched) return
    const next = !sched.enabled
    setMsg('')
    try {
      const r = await fetch(api(`/schedules/${sched.id}`), { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled: next }) }).then(x => x.json())
      if (r?.id) { setSched(r); onAutoDefendRef.current?.({ enabled: r.enabled && (!!serverBaseline || serverWindows.length > 0), scheduleId: r.id }) }
      setMsg(next ? 'Auto-defend ON — the engine holds this plan on its cadence (live pushes still need the write-gate).' : 'Auto-defend OFF — plan saved but not auto-held.')
    } catch { setMsg('Could not toggle auto-defend.') }
  }

  if (!campaignId) return null

  return (
    <div className="az-rp">
      <div className="az-rp-head">
        <span className="t"><Crosshair size={15} /> Rank plan <span className="sub">· {campaignName}</span></span>
        {sched && <button type="button" className={`az-rp-defend ${sched.enabled ? 'on' : ''}`} onClick={() => void toggleDefend()} title="When ON, the engine continuously holds this plan on its cadence"><Power size={12} /> Auto-defend {sched.enabled ? 'ON' : 'OFF'}</button>}
        <span className="grow" />
        {dirty && <span className="az-rp-dirty">Unsaved</span>}
        <button type="button" className="az-btn" disabled={!dirty || busy !== ''} onClick={discard}><Undo2 size={13} /> Discard</button>
        <button type="button" className="az-btn" disabled={!dirty || busy !== ''} onClick={() => void save()}><Save size={13} /> {busy === 'save' ? 'Saving…' : 'Save'}</button>
        <button type="button" className="az-btn dark" disabled={busy !== '' || (!baseline && windows.length === 0)} onClick={() => void publish()}><UploadCloud size={13} /> {busy === 'publish' ? 'Publishing…' : 'Publish'}</button>
      </div>

      {!loaded ? <div className="az-rp-load">Loading rank plan…</div> : <>
        {/* Baseline — "for the rest, hold Y" */}
        <div className="az-rp-sec">
          <div className="az-rp-lbl">Baseline — the rest of the week, hold:</div>
          <div className="az-rp-chips">
            {targets.map(t => <button key={t.key} type="button" className={`az-rp-chip ${baseline === t.key ? 'on' : ''}`} style={baseline === t.key && t.color ? { borderColor: t.color, boxShadow: `0 0 0 1px ${t.color} inset` } : undefined} onClick={() => setBaseline(baseline === t.key ? '' : t.key)} title={t.allOut ? 'Ignores ACOS — holds at any cost' : t.targetISPct != null ? `Target ${t.targetISPct}% top-of-search share` : ''}>
              <span className="sw" style={{ background: t.color ?? '#999' }} />{t.name}{t.allOut && <span className="ao">ALL-OUT</span>}
            </button>)}
          </div>
        </div>

        {/* RD.10b — when the product family actually sells (the dayparting heatmap) */}
        {demand?.hasData && (
          <div className="az-rp-sec">
            <div className="az-rp-lbl az-rp-dphd">
              <span>When this product&apos;s family sells{famName ? ` · ${famName.slice(0, 26)}` : ''}: <b className="az-rp-sample">{demand.familyOrders} actual orders · {demandDays}d</b></span>
              <span className="grow" />
              {smoothed && <label className="az-rp-smooth" title="Sparse product? Smooth toward the market's overall pattern. Off = your real sales."><input type="checkbox" checked={smooth} onChange={e => setSmooth(e.target.checked)} /> smooth</label>}
              <select className="az-rp-tf" value={demandDays} onChange={e => setDemandDays(Number(e.target.value))} aria-label="Demand timeframe" title="Timeframe for the demand data">
                {[7, 14, 30, 60, 90, 180].map(d => <option key={d} value={d}>last {d}d</option>)}
              </select>
              {rec && rec.windows.length > 0 && <button type="button" className="az-link" onClick={applyRecommended} title="Set windows from the demand peaks"><Wand2 size={12} /> Recommend windows</button>}
            </div>
            <DemandReadout grid={(smooth && smoothed ? smoothed : demand).grid} hourProfile={(smooth && smoothed ? smoothed : demand).hourProfile} weekdayProfile={(smooth && smoothed ? smoothed : demand).weekdayProfile} timezone={demand.timezone} metric={demand.metric} />
          </div>
        )}

        {/* Target windows — "these hours, hold X" */}
        <div className="az-rp-sec">
          <div className="az-rp-lbl" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>During these windows, hold a different rank:<span className="grow" />
            <span className="az-mode-seg az-scope-seg" role="tablist" aria-label="Window editor view" style={{ display: 'inline-flex', border: '1px solid var(--border)', borderRadius: 6, overflow: 'hidden' }}>
              <button type="button" role="tab" aria-selected={winView === 'grid'} className={winView === 'grid' ? 'on' : ''} onClick={() => setWinView('grid')}>Grid</button>
              <button type="button" role="tab" aria-selected={winView === 'list'} className={winView === 'list' ? 'on' : ''} onClick={() => setWinView('list')}>List</button>
            </span>
            {winView === 'list' && <button type="button" className="az-link" onClick={addWindow}><Plus size={12} /> Add window</button>}
          </div>
          {winView === 'grid' ? (
            <RankTimeGrid windows={windows} onWindowsChange={setWindows} targets={targets} baselineKey={baseline} demandGrid={(smooth && smoothed ? smoothed : demand)?.grid ?? null} onUseDemandPeaks={rec?.windows?.length ? applyRecommended : undefined} onEditTargets={() => setEditorOpen(true)} onOpenTemplates={() => setTplOpen(true)} />
          ) : (<>
            {windows.length === 0 && <div className="az-rp-empty">No time windows — the baseline applies all week. Add one to push harder during peak hours.</div>}
            {windows.map((w, i) => (
              <div key={i} className="az-rp-win">
                <div className="days">{DAYS.map((d, di) => <button key={di} type="button" className={w.days.includes(di) ? 'on' : ''} onClick={() => toggleDay(i, di)}>{d[0]}</button>)}</div>
                <select value={w.startHour} onChange={e => setWin(i, { startHour: Number(e.target.value) })} aria-label="Start hour">{Array.from({ length: 24 }, (_, h) => <option key={h} value={h}>{hh(h)}</option>)}</select>
                <span className="to">to</span>
                <select value={w.endHour} onChange={e => setWin(i, { endHour: Number(e.target.value) })} aria-label="End hour">{Array.from({ length: 25 }, (_, h) => <option key={h} value={h}>{hh(h % 24)}{h === 24 ? ' (24)' : ''}</option>)}</select>
                <span className="arrow">→</span>
                <select value={w.targetKey ?? ''} onChange={e => setWin(i, { targetKey: e.target.value })} aria-label="Rank target">{targets.map(t => <option key={t.key} value={t.key}>{t.name}</option>)}</select>
                <span className="grow" />
                <button type="button" className="az-kebab" onClick={() => removeWin(i)} style={{ color: '#cc1100' }} aria-label="Remove window"><Trash2 size={13} /></button>
              </div>
            ))}
          </>)}
        </div>

        {/* Live defend preview */}
        {decision && (
          <div className="az-rp-preview"><Sparkles size={13} />
            <span>Right now the loop would <b>{decision.action === 'pause' ? 'drop to Min bid' : decision.action}</b>{decision.action === 'raise' || decision.action === 'lower' ? ` → ${decision.nextPct}% placement bias` : ''}{decision.lossDetected ? ' (slipping — re-taking)' : ''} — <i>{decision.reason}</i>{decision.achievedISPct != null ? ` · IS ${decision.achievedISPct}%` : ' · no IS data yet'}.</span>
            {/* BL.8 — per-placement breakdown when the active target is a blend */}
            {decision.lanes && decision.lanes.length > 0 && (
              <div className="az-blend-dec">
                {decision.lanes.map(l => <span key={l.placement} className="az-blend-chip" title={`${l.action} ${SHORT_PL[l.placement] ?? l.placement}`}>{SHORT_PL[l.placement] ?? l.placement} {l.fromPct === l.toPct ? `${l.toPct}%` : `${l.fromPct}→${l.toPct}%`}</span>)}
                {decision.baseBid && decision.baseBid.mode !== 'hold' && <span className="az-blend-chip base">base {decision.baseBid.mode === 'absolute' && decision.baseBid.valueCents != null ? `€${(decision.baseBid.valueCents / 100).toFixed(2)}` : decision.baseBid.mode}</span>}
              </div>
            )}
          </div>
        )}

        {/* B1 — is it actually reaching Amazon? (delivery truth: live/sandbox · gated · pending · last push) */}
        {campaignId && <DeliveryChip campaignId={campaignId} reloadSignal={reloadSignal} />}

        {msg && <div className="az-rp-msg">{msg}</div>}
        <div className="az-rp-note">Save stores the plan in Nexus (survives reload). Publish runs the defend loop now; real Amazon pushes still honour the write-gate (sandbox stays local). The loop also runs on its own once armed.</div>
      </>}

      <RankTargetEditor
        open={editorOpen}
        onClose={(c) => { setEditorOpen(false); if (c) void load() }}
        scopeKind="campaign"
        scopeLabel={campaignName}
        scopeOverrides={(sched?.targetOverrides as Record<string, { biasPct?: number; targetISPct?: number; acosCapPct?: number; maxCpcCents?: number }>) ?? {}}
        onSaveScopeOverrides={sched ? async (map) => { const r = await fetch(api(`/schedules/${sched.id}`), { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ targetOverrides: map }) }).then(x => x.json()); if (r?.id) setSched(r) } : undefined}
        campaignId={campaignId}
      />
      <RankTemplateModal open={tplOpen} onClose={() => setTplOpen(false)} currentWindows={windows} currentBaseline={baseline} onLoad={(w, bl) => { setWindows(w); if (bl != null) setBaseline(bl) }} />
    </div>
  )
}
