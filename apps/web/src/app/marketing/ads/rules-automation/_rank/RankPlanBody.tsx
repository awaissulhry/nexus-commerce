'use client'

/**
 * RGD.1 — Rank Plan body (the §2 "Your rank goal & schedule" cockpit), re-skinned to H10 and made
 * MULTI-CAMPAIGN. Author ONE plan — a baseline rank ("for the rest of the week, hold Y") + time
 * windows ("Mon–Fri 18–22 → Own Top") — and Save / Publish / Discard it across every selected
 * campaign at once (fan-out: one /schedules row per campaign). Live defend preview + delivery truth
 * are shown per campaign. Save persists to Nexus; Publish runs the defend loop now (gated — sandbox
 * stays local). Grid painter (RGD.2), demand heatmap (RGD.3), target editor (RGD.4) and templates
 * (RGD.5) land in later phases.
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import { Crosshair, Plus, Trash2, Save, UploadCloud, Undo2, Sparkles, Power, Wand2 } from 'lucide-react'
import { getBackendUrl } from '@/lib/backend-url'
import type { SchedCampaign } from '../_schedule/CampaignSection'
import { DeliveryChip } from './DeliveryChip'
import { RankTimeGrid } from './RankTimeGrid'
import { DemandReadout, type DemandCell, type DemandProfile } from './DemandReadout'
import { RankTargetEditor, type OvMap } from './RankTargetEditor'
import { RankTemplateModal } from './RankTemplateModal'

interface DemandData { grid: DemandCell[][]; hourProfile: DemandProfile[]; weekdayProfile: DemandProfile[]; hasData: boolean; familyOrders: number; timezone?: string; metric?: 'revenue' | 'orders' }
interface RecData { windows: Win[]; baselineTargetKey: string; peakHours: number[] }

interface RankTarget { key: string; name: string; placement: string; targetISPct: number | null; acosCapPct: number | null; allOut: boolean; color: string | null }
interface Win { days: number[]; startHour: number; endHour: number; targetKey?: string }
interface Sched { id: string; campaignId: string; name: string; windows: Win[]; timezone: string; enabled: boolean; defaultTargetKey?: string | null; targetOverrides?: OvMap }
interface Decision { campaignId: string; campaignName?: string; action: string; reason: string; currentPct?: number; nextPct?: number; achievedISPct: number | null; lossDetected?: boolean }

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const hh = (h: number) => `${String(h).padStart(2, '0')}:00`
const api = (p: string) => `${getBackendUrl()}/api/advertising${p}`

export function RankPlanBody({ campaigns, name }: { campaigns: SchedCampaign[]; name: string }) {
  const campKey = useMemo(() => campaigns.map(c => c.id).sort().join(','), [campaigns])
  const [targets, setTargets] = useState<RankTarget[]>([])
  const [scheds, setScheds] = useState<Record<string, Sched | null>>({}) // per-campaign existing schedule
  const [baseline, setBaseline] = useState('')
  const [windows, setWindows] = useState<Win[]>([])
  const [serverBaseline, setServerBaseline] = useState('')
  const [serverWindows, setServerWindows] = useState<Win[]>([])
  const [loaded, setLoaded] = useState(false)
  const [busy, setBusy] = useState<'' | 'save' | 'publish'>('')
  const [msg, setMsg] = useState('')
  const [decisions, setDecisions] = useState<Decision[]>([])
  const [deliverySignal, setDeliverySignal] = useState(0)
  const [winView, setWinView] = useState<'grid' | 'list'>('grid') // RGD.2 — paint grid (default) vs precise list
  // RGD.3 — demand heatmap. Per-campaign (product-dayparting is per campaign); a selector picks
  // which of the selected campaigns to read demand from, informing the shared plan's windows.
  const [demandCampaignId, setDemandCampaignId] = useState('')
  const [demand, setDemand] = useState<DemandData | null>(null)
  const [smoothed, setSmoothed] = useState<{ grid: DemandCell[][]; hourProfile: DemandProfile[]; weekdayProfile: DemandProfile[] } | null>(null)
  const [rec, setRec] = useState<RecData | null>(null)
  const [smooth, setSmooth] = useState(false) // false = raw actual sales (default); true = market-smoothed
  const [demandDays, setDemandDays] = useState(180)
  const [famName, setFamName] = useState('')
  const [editorOpen, setEditorOpen] = useState(false) // RGD.4 — rank-target customizer modal
  const [tplOpen, setTplOpen] = useState(false) // RGD.5 — schedule-templates modal

  // load global rank targets + each selected campaign's existing schedule
  const load = useCallback(async () => {
    setLoaded(false)
    const ids = campKey ? campKey.split(',') : []
    const [ts, ss] = await Promise.all([
      fetch(api('/rank-targets'), { cache: 'no-store' }).then(r => r.json()).catch(() => ({ items: [] })),
      fetch(api('/schedules'), { cache: 'no-store' }).then(r => r.json()).catch(() => ({ items: [] })),
    ])
    setTargets(ts.items ?? [])
    const all: Sched[] = ss.items ?? []
    const mine: Record<string, Sched | null> = {}
    for (const id of ids) mine[id] = all.find(s => s.campaignId === id) ?? null
    setScheds(mine)
    // Seed the working plan from the first selected campaign that already has a schedule (fan-out
    // model — one authored plan overwrites all on save). Empty if none yet.
    const seed = ids.map(id => mine[id]).find(Boolean) ?? null
    const bk = seed?.defaultTargetKey ?? ''
    const wins = (seed?.windows ?? []).filter(w => w?.targetKey)
    setBaseline(bk); setServerBaseline(bk)
    setWindows(wins.map(w => ({ ...w }))); setServerWindows(wins.map(w => ({ ...w })))
    setLoaded(true)
  }, [campKey])
  useEffect(() => { void load() }, [load])

  // live "what would the loop do right now" for the selected campaigns (only once a goal exists)
  useEffect(() => {
    if (!campKey || (!serverBaseline && serverWindows.length === 0)) { setDecisions([]); return }
    const ids = new Set(campKey.split(','))
    void fetch(api('/rank-defend/run-now?dryRun=1'), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })
      .then(r => r.json()).then(d => setDecisions((d.decisions ?? []).filter((x: Decision) => ids.has(x.campaignId)))).catch(() => {})
  }, [campKey, serverBaseline, serverWindows])

  // keep the demand-campaign valid (default to the first selected campaign)
  useEffect(() => {
    const ids = campKey ? campKey.split(',') : []
    if (!ids.length) { setDemandCampaignId(''); return }
    if (!ids.includes(demandCampaignId)) setDemandCampaignId(ids[0])
  }, [campKey, demandCampaignId])

  // RGD.3 — family demand for the chosen campaign's product over the timeframe + recommended windows
  useEffect(() => {
    if (!demandCampaignId) { setDemand(null); setFamName(''); setRec(null); setSmoothed(null); return }
    void fetch(api(`/campaigns/${demandCampaignId}/product-dayparting?windowDays=${demandDays}`), { cache: 'no-store' })
      .then(r => r.json()).then(d => { setDemand(d.demand ?? null); setSmoothed(d.smoothed ?? null); setFamName(d.parentName ?? ''); setRec(d.recommended ?? null) }).catch(() => { setDemand(null) })
  }, [demandCampaignId, demandDays])
  const applyRecommended = () => { if (!rec) return; setWindows(rec.windows.map(w => ({ ...w }))); if (rec.baselineTargetKey) setBaseline(rec.baselineTargetKey) }
  const activeDemand = smooth && smoothed ? smoothed : demand

  const dirty = baseline !== serverBaseline || JSON.stringify(windows) !== JSON.stringify(serverWindows)
  const anySched = Object.values(scheds).some(Boolean)
  const allEnabled = campaigns.length > 0 && campaigns.every(c => scheds[c.id]?.enabled)
  const hasGoal = !!baseline || windows.length > 0

  const addWindow = () => setWindows(w => [...w, { days: [1, 2, 3, 4, 5], startHour: 18, endHour: 22, targetKey: targets[0]?.key }])
  const setWin = (i: number, patch: Partial<Win>) => setWindows(w => w.map((x, j) => j === i ? { ...x, ...patch } : x))
  const removeWin = (i: number) => setWindows(w => w.filter((_, j) => j !== i))
  const toggleDay = (i: number, d: number) => setWindows(w => w.map((x, j) => j === i ? { ...x, days: x.days.includes(d) ? x.days.filter(y => y !== d) : [...x.days, d].sort() } : x))

  // fan-out persist: upsert each selected campaign's schedule with the SAME authored plan
  const persistAll = async (): Promise<Record<string, Sched | null>> => {
    const body = { defaultTargetKey: baseline || null, windows }
    const next: Record<string, Sched | null> = { ...scheds }
    await Promise.all(campaigns.map(async c => {
      const existing = scheds[c.id]
      try {
        if (existing) {
          const r = await fetch(api(`/schedules/${existing.id}`), { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then(x => x.json())
          if (r?.id) next[c.id] = r
        } else {
          // Safety: the builder creates plans DISABLED (auto-defend OFF). Save only STORES the plan;
          // arming the live defend loop is a deliberate act — flip Auto-defend on, or Publish.
          const r = await fetch(api('/schedules'), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ campaignId: c.id, name: (name.trim() || `Rank plan — ${c.name}`), timezone: 'Europe/Rome', enabled: false, ...body }) }).then(x => x.json())
          if (r?.id) next[c.id] = r
        }
      } catch { /* per-campaign failure leaves its prior entry */ }
    }))
    setScheds(next)
    return next
  }
  const markSaved = () => { setServerBaseline(baseline); setServerWindows(windows.map(w => ({ ...w }))) }

  const save = async () => {
    if (!campaigns.length) return
    setBusy('save'); setMsg('')
    try { const r = await persistAll(); const ok = Object.values(r).filter(Boolean).length; markSaved(); setMsg(`Saved — your rank plan is stored for ${ok} campaign${ok === 1 ? '' : 's'} (not armed). Turn on Auto-defend to hold it automatically, or Publish to run it once. Live pushes honour each campaign's write-gate.`) }
    finally { setBusy('') }
  }
  const publish = async () => {
    if (!campaigns.length) return
    setBusy('publish'); setMsg('')
    try {
      if (dirty) { await persistAll(); markSaved() }
      const r = await fetch(api('/rank-defend/run-now'), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }).then(x => x.json()).catch(() => null)
      const ids = new Set(campaigns.map(c => c.id))
      setDecisions((r?.decisions ?? []).filter((x: Decision) => ids.has(x.campaignId)))
      setDeliverySignal(n => n + 1)
      setMsg(r ? `Published — defend loop ran (${r.applied ?? 0} change${r.applied === 1 ? '' : 's'} applied; live pushes honour the write-gate).` : 'Publish ran.')
    } finally { setBusy('') }
  }
  const discard = () => { setBaseline(serverBaseline); setWindows(serverWindows.map(w => ({ ...w }))); setMsg('') }

  // Auto-defend across all selected campaigns' schedules (only meaningful once saved)
  const toggleDefend = async () => {
    if (!anySched) return
    const next = !allEnabled
    setMsg('')
    const updated: Record<string, Sched | null> = { ...scheds }
    await Promise.all(campaigns.map(async c => {
      const s = scheds[c.id]; if (!s) return
      try { const r = await fetch(api(`/schedules/${s.id}`), { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled: next }) }).then(x => x.json()); if (r?.id) updated[c.id] = r } catch { /* best-effort */ }
    }))
    setScheds(updated)
    setMsg(next ? 'Auto-defend ON — the engine holds this plan on its cadence (live pushes still need the write-gate).' : 'Auto-defend OFF — plan saved but not auto-held.')
  }

  // RGD.4 — the "Edit targets" modal edits GLOBAL swatches (shared across all selected campaigns) +
  // per-campaign OVERRIDES scoped to the active demand-campaign (only once it has a saved schedule).
  const activeSched = demandCampaignId ? scheds[demandCampaignId] : null
  const activeCampName = campaigns.find(c => c.id === demandCampaignId)?.name ?? 'this campaign'
  const saveScopeOverrides = activeSched ? async (map: OvMap) => {
    const r = await fetch(api(`/schedules/${activeSched.id}`), { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ targetOverrides: map }) }).then(x => x.json())
    if (r?.id && demandCampaignId) setScheds(s => ({ ...s, [demandCampaignId]: r }))
  } : undefined

  if (!campaigns.length) {
    return <div className="h10-rgd-stub"><Crosshair size={26} /><b>Add campaigns first</b><span>Pick the campaigns above, then set a baseline rank + time windows here — one plan held across all of them.</span></div>
  }

  return (
    <div className="h10-rp">
      <div className="h10-rp-head">
        <span className="t"><Crosshair size={15} /> Rank plan{name.trim() ? <span className="sub"> · {name.trim()}</span> : ''} <span className="sub">· {campaigns.length} campaign{campaigns.length === 1 ? '' : 's'}</span></span>
        {anySched && <button type="button" className={`h10-rp-defend ${allEnabled ? 'on' : ''}`} onClick={() => void toggleDefend()} title="When ON, the engine continuously holds this plan on its cadence"><Power size={12} /> Auto-defend {allEnabled ? 'ON' : 'OFF'}</button>}
        <span className="grow" />
        {dirty && <span className="h10-rp-dirty">Unsaved</span>}
        <button type="button" className="h10-rp-btn" disabled={!dirty || busy !== ''} onClick={discard}><Undo2 size={13} /> Discard</button>
        <button type="button" className="h10-rp-btn" disabled={!dirty || busy !== ''} onClick={() => void save()}><Save size={13} /> {busy === 'save' ? 'Saving…' : 'Save'}</button>
        <button type="button" className="h10-rp-btn dark" disabled={busy !== '' || !hasGoal} onClick={() => void publish()}><UploadCloud size={13} /> {busy === 'publish' ? 'Publishing…' : 'Publish'}</button>
      </div>

      {!loaded ? <div className="h10-rp-load">Loading rank plan…</div> : <>
        {/* Baseline — "for the rest, hold Y" */}
        <div className="h10-rp-sec">
          <div className="h10-rp-lbl">Baseline — the rest of the week, hold:</div>
          <div className="h10-rp-chips">
            {targets.map(t => (
              <button key={t.key} type="button" className={`h10-rp-chip ${baseline === t.key ? 'on' : ''}`} style={baseline === t.key && t.color ? { borderColor: t.color, boxShadow: `0 0 0 1px ${t.color} inset` } : undefined} onClick={() => setBaseline(baseline === t.key ? '' : t.key)} title={t.allOut ? 'Ignores ACOS — holds at any cost' : t.targetISPct != null ? `Target ${t.targetISPct}% top-of-search share` : ''}>
                <span className="sw" style={{ background: t.color ?? '#999' }} />{t.name}{t.allOut && <span className="ao">ALL-OUT</span>}
              </button>
            ))}
          </div>
        </div>

        {/* RGD.3 — when the product family actually sells (the dayparting heatmap) */}
        {demand?.hasData && activeDemand && (
          <div className="h10-rp-sec">
            <div className="h10-rp-lbl wins">
              <span>When this product&apos;s family sells{famName ? ` · ${famName.slice(0, 26)}` : ''}: <b className="h10-rp-sample">{demand.familyOrders} actual orders · {demandDays}d</b></span>
              <span className="grow" />
              {campaigns.length > 1 && (
                <select className="h10-rp-tf" value={demandCampaignId} onChange={e => setDemandCampaignId(e.target.value)} aria-label="Demand campaign" title="Which selected campaign's product demand to show">
                  {campaigns.map(c => <option key={c.id} value={c.id}>{c.name.length > 30 ? c.name.slice(0, 30) + '…' : c.name}</option>)}
                </select>
              )}
              {smoothed && <label className="h10-rp-smooth" title="Sparse product? Smooth toward the market's overall pattern. Off = your real sales."><input type="checkbox" checked={smooth} onChange={e => setSmooth(e.target.checked)} /> smooth</label>}
              <select className="h10-rp-tf" value={demandDays} onChange={e => setDemandDays(Number(e.target.value))} aria-label="Demand timeframe" title="Timeframe for the demand data">
                {[7, 14, 30, 60, 90, 180].map(d => <option key={d} value={d}>last {d}d</option>)}
              </select>
              {rec && rec.windows.length > 0 && <button type="button" className="h10-rp-link" onClick={applyRecommended} title="Set windows from the demand peaks"><Wand2 size={12} /> Recommend windows</button>}
            </div>
            <DemandReadout grid={activeDemand.grid} hourProfile={activeDemand.hourProfile} weekdayProfile={activeDemand.weekdayProfile} timezone={demand.timezone} metric={demand.metric} />
          </div>
        )}

        {/* Target windows — Grid painter (default) ↔ precise List editor */}
        <div className="h10-rp-sec">
          <div className="h10-rp-lbl wins">During these windows, hold a different rank:<span className="grow" />
            <span className="h10-rp-seg" role="tablist" aria-label="Window editor view">
              <button type="button" role="tab" aria-selected={winView === 'grid'} className={winView === 'grid' ? 'on' : ''} onClick={() => setWinView('grid')}>Grid</button>
              <button type="button" role="tab" aria-selected={winView === 'list'} className={winView === 'list' ? 'on' : ''} onClick={() => setWinView('list')}>List</button>
            </span>
            {winView === 'list' && <button type="button" className="h10-rp-link" onClick={addWindow}><Plus size={12} /> Add window</button>}
          </div>
          {winView === 'grid' ? (
            <RankTimeGrid windows={windows} onWindowsChange={setWindows} targets={targets} baselineKey={baseline} demandGrid={activeDemand?.grid ?? null} onUseDemandPeaks={rec?.windows?.length ? applyRecommended : undefined} onEditTargets={() => setEditorOpen(true)} onOpenTemplates={() => setTplOpen(true)} />
          ) : (<>
            {windows.length === 0 && <div className="h10-rp-empty">No time windows — the baseline applies all week. Add one to push harder during peak hours.</div>}
            {windows.map((w, i) => (
              <div key={i} className="h10-rp-win">
                <div className="days">{DAYS.map((d, di) => <button key={di} type="button" className={w.days.includes(di) ? 'on' : ''} onClick={() => toggleDay(i, di)} aria-label={d} aria-pressed={w.days.includes(di)}>{d[0]}</button>)}</div>
                <select value={w.startHour} onChange={e => setWin(i, { startHour: Number(e.target.value) })} aria-label="Start hour">{Array.from({ length: 24 }, (_, h) => <option key={h} value={h}>{hh(h)}</option>)}</select>
                <span className="to">to</span>
                <select value={w.endHour} onChange={e => setWin(i, { endHour: Number(e.target.value) })} aria-label="End hour">{Array.from({ length: 25 }, (_, h) => <option key={h} value={h}>{hh(h % 24)}{h === 24 ? ' (24)' : ''}</option>)}</select>
                <span className="arrow">→</span>
                <select value={w.targetKey ?? ''} onChange={e => setWin(i, { targetKey: e.target.value })} aria-label="Rank target">{targets.map(t => <option key={t.key} value={t.key}>{t.name}</option>)}</select>
                <span className="grow" />
                <button type="button" className="rm" onClick={() => removeWin(i)} aria-label="Remove window"><Trash2 size={13} /></button>
              </div>
            ))}
          </>)}
        </div>

        {/* Live defend preview + delivery, per campaign */}
        {decisions.length > 0 && (
          <div className="h10-rp-sec">
            <div className="h10-rp-lbl"><Sparkles size={13} /> Right now, per campaign:</div>
            <div className="h10-rp-decs">
              {decisions.map(d => (
                <div key={d.campaignId} className="h10-rp-dec">
                  <b title={d.campaignName ?? d.campaignId}>{d.campaignName ?? d.campaignId}</b>
                  <span className="act">would <b>{d.action === 'pause' ? 'drop to Min bid' : d.action}</b>{d.nextPct != null && (d.action === 'raise' || d.action === 'lower') ? ` → ${d.nextPct}% bias` : ''}{d.lossDetected ? ' (slipping — re-taking)' : ''} — <i>{d.reason}</i>{d.achievedISPct != null ? ` · IS ${d.achievedISPct}%` : ''}</span>
                  <DeliveryChip campaignId={d.campaignId} reloadSignal={deliverySignal} />
                </div>
              ))}
            </div>
          </div>
        )}

        {msg && <div className="h10-rp-msg">{msg}</div>}
        <div className="h10-rp-note">Save stores the plan (disabled) for every selected campaign — nothing changes on Amazon yet. Turn on <b>Auto-defend</b> to have the engine hold it automatically, or <b>Publish</b> to run the loop once. Either way, real Amazon pushes still honour each campaign&apos;s write-gate (sandbox stays local).</div>
      </>}

      <RankTargetEditor
        open={editorOpen}
        onClose={(c) => { setEditorOpen(false); if (c) void load() }}
        scopeKind="campaign"
        scopeLabel={activeCampName}
        scopeOverrides={activeSched?.targetOverrides ?? {}}
        onSaveScopeOverrides={saveScopeOverrides}
        campaignId={demandCampaignId}
      />
      <RankTemplateModal
        open={tplOpen}
        onClose={() => setTplOpen(false)}
        currentWindows={windows}
        currentBaseline={baseline}
        onLoad={(w, bl) => { setWindows(w); if (bl != null) setBaseline(bl) }}
      />
    </div>
  )
}
