'use client'

/**
 * RGD.1 — Rank Plan body (the §2 "Your rank goal & schedule" cockpit), re-skinned to H10 and made
 * MULTI-CAMPAIGN. Author ONE plan — a baseline rank ("for the rest of the week, hold Y") + time
 * windows ("Mon–Fri 18–22 → Own Top") — applied across every selected campaign at once. Saved as
 * ONE NAMED GROUP (RankScheduleGroup): the API materializes one AdSchedule row per member campaign
 * (which the rank-defend cron runs — engine untouched) but the list shows a single named row. Edit
 * via ?groupId reloads name + all members. Live defend preview + delivery truth are shown per campaign.
 *
 * RGD.7 — the action model follows the rules-automation convention: there's no Save/Publish/Discard
 * trio here. The parent builder owns ONE "Create Schedule" action + a Manual/Automate Control section
 * and calls our exposed save(enabled) via a ref; we report {valid,busy,dirty} up via onStatus.
 * Manual → enabled:false (saved but off); Automate → enabled:true (held on cadence, write-gated).
 */
import { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react'
import { Crosshair, Plus, Trash2, Sparkles, Wand2 } from 'lucide-react'
import { Button, Select } from '@/design-system/primitives'
import { getBackendUrl } from '@/lib/backend-url'

import type { SchedCampaign } from '../_schedule/CampaignSection'
import { DeliveryChip } from './DeliveryChip'
import { RankTimeGrid } from './RankTimeGrid'
import { DemandReadout, type DemandCell, type DemandProfile } from './DemandReadout'
import { RankTargetEditor, type OvMap } from './RankTargetEditor'
import { RankTemplateModal } from './RankTemplateModal'
import { Listbox } from '@/design-system/components'

export interface RankPlanHandle { save: (enabled: boolean) => Promise<void> }
export interface RankPlanStatus { valid: boolean; busy: boolean; dirty: boolean; saved: boolean }

interface DemandData { grid: DemandCell[][]; hourProfile: DemandProfile[]; weekdayProfile: DemandProfile[]; hasData: boolean; familyOrders: number; timezone?: string; metric?: 'revenue' | 'orders' }
interface RecData { windows: Win[]; baselineTargetKey: string; peakHours: number[] }

interface RankTarget { key: string; name: string; placement: string; targetISPct: number | null; acosCapPct: number | null; allOut: boolean; color: string | null }
interface Win { days: number[]; startHour: number; endHour: number; targetKey?: string }
interface Sched { id: string; campaignId: string; name: string; windows: Win[]; timezone: string; enabled: boolean; defaultTargetKey?: string | null; targetOverrides?: OvMap }
interface Decision { campaignId: string; campaignName?: string; action: string; reason: string; currentPct?: number; nextPct?: number; achievedISPct: number | null; lossDetected?: boolean }

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const hh = (h: number) => `${String(h).padStart(2, '0')}:00`
const api = (p: string) => `${getBackendUrl()}/api/advertising${p}`

export const RankPlanBody = forwardRef<RankPlanHandle, { campaigns: SchedCampaign[]; name: string; groupId?: string; portfolioId?: string; onStatus?: (s: RankPlanStatus) => void; onGroupCreated?: (id: string) => void }>(function RankPlanBody({ campaigns, name, groupId, portfolioId, onStatus, onGroupCreated }, ref) {
  // DPS.1 — the id of a group THIS session created. Before this existed, `groupId` came only from
  // the URL, so the 2nd save in a session was still a POST → a brand-new group every time, and the
  // server rebound the member schedules to it, stranding the previous group at zero members. (Live
  // evidence: "IT AIRMESH" ×4 created within 82s, three of them empty.) Holding the created id here
  // makes save #2 onward a PATCH even before the URL round-trips.
  const [ownGroupId, setOwnGroupId] = useState<string | null>(null)
  const campKey = useMemo(() => campaigns.map(c => c.id).sort().join(','), [campaigns])
  const [targets, setTargets] = useState<RankTarget[]>([])
  const [scheds, setScheds] = useState<Record<string, Sched | null>>({}) // per-campaign existing schedule
  const [baseline, setBaseline] = useState('')
  const [windows, setWindows] = useState<Win[]>([])
  const [serverBaseline, setServerBaseline] = useState('')
  const [serverWindows, setServerWindows] = useState<Win[]>([])
  const [loaded, setLoaded] = useState(false)
  const [savedOnce, setSavedOnce] = useState(false)
  const [busy, setBusy] = useState(false)
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
  const saved = !!groupId || !!ownGroupId || savedOnce || Object.values(scheds).some(Boolean)
  const hasGoal = !!baseline || windows.length > 0
  // Report state up so the parent builder can drive its single action. Name is compulsory now —
  // a schedule can't be saved without one (the builder disables the button until it's set).
  useEffect(() => { onStatus?.({ valid: campaigns.length > 0 && hasGoal && !!name.trim(), busy, dirty, saved }) }, [campaigns.length, hasGoal, name, busy, dirty, saved, onStatus])

  const addWindow = () => setWindows(w => [...w, { days: [1, 2, 3, 4, 5], startHour: 18, endHour: 22, targetKey: targets[0]?.key }])
  const setWin = (i: number, patch: Partial<Win>) => setWindows(w => w.map((x, j) => j === i ? { ...x, ...patch } : x))
  const removeWin = (i: number) => setWindows(w => w.filter((_, j) => j !== i))
  const toggleDay = (i: number, d: number) => setWindows(w => w.map((x, j) => j === i ? { ...x, days: x.days.includes(d) ? x.days.filter(y => y !== d) : [...x.days, d].sort() } : x))

  // Persist as ONE named group. The API materializes one AdSchedule row per member campaign (which
  // the rank-defend cron runs — engine untouched). Per-campaign overrides are preserved by gathering
  // them from the loaded member schedules and passing them in the group's per-campaign map.
  const saveGroup = async (enabled: boolean): Promise<{ ok: boolean; id?: string; created?: boolean }> => {
    const perCamp: Record<string, unknown> = {}
    for (const c of campaigns) { const o = scheds[c.id]?.targetOverrides; if (o && Object.keys(o).length) perCamp[c.id] = o }
    // DPS.1 — an id from EITHER the URL (edit mode) or this session's earlier save (create mode).
    const gid = groupId || ownGroupId
    const body = { id: gid || undefined, name: name.trim(), campaignIds: campaigns.map(c => c.id), windows, defaultTargetKey: baseline || null, targetOverrides: perCamp, enabled, timezone: 'Europe/Rome', portfolioId: portfolioId || null }
    const url = gid ? api(`/rank-schedule-groups/${gid}`) : api('/rank-schedule-groups')
    const r = await fetch(url, { method: gid ? 'PATCH' : 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then(x => x.json()).catch(() => null)
    return { ok: !!r?.id, id: r?.id, created: !gid }
  }
  const markSaved = () => { setServerBaseline(baseline); setServerWindows(windows.map(w => ({ ...w }))) }

  // The ONE action, invoked by the parent's "Create Schedule" / "Save Changes" with the Control flag.
  const doSave = async (enabled: boolean) => {
    if (!campaigns.length || busy) return
    if (!name.trim()) { setMsg('Name your schedule first — a schedule name is required.'); return }
    setBusy(true); setMsg('')
    try {
      const r = await saveGroup(enabled)
      if (r.ok) {
        // DPS.1 — remember the id we just minted so the NEXT save patches this group instead of
        // creating another one, and hand it up so the URL becomes ?groupId=… (shareable + refresh-safe).
        if (r.created && r.id) { setOwnGroupId(r.id); onGroupCreated?.(r.id) }
        markSaved(); setSavedOnce(true); setDeliverySignal(n => n + 1)
        const n = campaigns.length
        setMsg(enabled
          ? `Saved + armed — one schedule "${name.trim()}" holding ${n} campaign${n === 1 ? '' : 's'} on its cadence (real Amazon pushes honour each campaign's write-gate; sandbox stays local).`
          : `Saved — one schedule "${name.trim()}" over ${n} campaign${n === 1 ? '' : 's'}. Manual, so nothing runs yet; set Control to Automate to hold it.`)
      } else setMsg('Save failed — please retry.')
    } finally { setBusy(false) }
  }
  // Expose a STABLE save() that always runs the latest closure (avoids dependency churn on the ref).
  const saveRef = useRef(doSave); saveRef.current = doSave
  useImperativeHandle(ref, () => ({ save: (enabled: boolean) => saveRef.current(enabled) }), [])

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
                // OS.4 — a native dropdown listing every selected campaign. A portfolio-scoped plan
                // can hold 11+ of them with near-identical names, so this needs the shared search.
                <Listbox
                  width={230}
                  options={campaigns.map(c => ({ value: c.id, label: c.name }))}
                  value={demandCampaignId}
                  onChange={setDemandCampaignId}
                  ariaLabel="Demand campaign"
                  searchable
                  searchPlaceholder="Search campaigns…"
                />
              )}
              {smoothed && <label className="h10-rp-smooth" title="Sparse product? Smooth toward the market's overall pattern. Off = your real sales."><input type="checkbox" checked={smooth} onChange={e => setSmooth(e.target.checked)} /> smooth</label>}
              <Select className="h10-rp-tf" size="xs" value={demandDays} onChange={e => setDemandDays(Number(e.target.value))} aria-label="Demand timeframe" title="Timeframe for the demand data">
                {[7, 14, 30, 60, 90, 180].map(d => <option key={d} value={d}>last {d}d</option>)}
              </Select>
              {rec && rec.windows.length > 0 && <Button variant="link" inline className="h10-rp-link" onClick={applyRecommended} title="Set windows from the demand peaks"><Wand2 size={12} /> Recommend windows</Button>}
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
            {winView === 'list' && <Button variant="link" inline className="h10-rp-link" onClick={addWindow}><Plus size={12} /> Add window</Button>}
          </div>
          {winView === 'grid' ? (
            <RankTimeGrid windows={windows} onWindowsChange={setWindows} targets={targets} baselineKey={baseline} demandGrid={activeDemand?.grid ?? null} onUseDemandPeaks={rec?.windows?.length ? applyRecommended : undefined} onEditTargets={() => setEditorOpen(true)} onOpenTemplates={() => setTplOpen(true)} />
          ) : (<>
            {windows.length === 0 && <div className="h10-rp-empty">No time windows — the baseline applies all week. Add one to push harder during peak hours.</div>}
            {windows.map((w, i) => (
              <div key={i} className="h10-rp-win">
                <div className="days">{DAYS.map((d, di) => <button key={di} type="button" className={w.days.includes(di) ? 'on' : ''} onClick={() => toggleDay(i, di)} aria-label={d} aria-pressed={w.days.includes(di)}>{d[0]}</button>)}</div>
                <Select size="sm" value={w.startHour} onChange={e => setWin(i, { startHour: Number(e.target.value) })} aria-label="Start hour">{Array.from({ length: 24 }, (_, h) => <option key={h} value={h}>{hh(h)}</option>)}</Select>
                <span className="to">to</span>
                <Select size="sm" value={w.endHour} onChange={e => setWin(i, { endHour: Number(e.target.value) })} aria-label="End hour">{Array.from({ length: 25 }, (_, h) => <option key={h} value={h}>{hh(h % 24)}{h === 24 ? ' (24)' : ''}</option>)}</Select>
                <span className="arrow">→</span>
                <Select size="sm" value={w.targetKey ?? ''} onChange={e => setWin(i, { targetKey: e.target.value })} aria-label="Rank target">{targets.map(t => <option key={t.key} value={t.key}>{t.name}</option>)}</Select>
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
        <div className="h10-rp-note">Choose <b>Manual</b> or <b>Automate</b> in Control below, then <b>Create Schedule</b>. Manual stores the plan for every selected campaign but runs nothing; Automate has the engine hold this rank on its cadence. Either way, real Amazon pushes honour each campaign&apos;s write-gate (sandbox stays local).</div>
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
})
