'use client'

/**
 * CP.2–CP.4 + P1.2–P1.3 — Budget Control Plane. The Allocation Map grown into an
 * operational surface that drills the ad ontology: market envelope → campaigns →
 * ad groups → targets. Select any node → an Inspector with the action controls
 * valid for that object type (campaign: budget/min-max/pin/suppress; ad group &
 * target: bid + status) that STAGE changes into a client-side scenario. A review
 * bar shows the batch + projected daily-budget Δ; Commit pushes it through the
 * gated + audited POST /scenario/commit (5-min grace undo). The Inspector also
 * shows each object's provenance (CampaignBidHistory, filtered to the entity).
 *
 * Palantir-style scenario → review → commit over the live ontology.
 */
import { useEffect, useMemo, useState } from 'react'
import { Lock, History as HistoryIcon } from 'lucide-react'
import { Modal } from '@/design-system/components'
import { AllocationCanvas, type StagedChange, type OntoNode, type SelectRef } from './AllocationCanvas'
import { getBackendUrl } from '@/lib/backend-url'
import './control-plane.css'

interface EnfCampaign { id: string; name: string; currentDailyCents: number; targetDailyCents: number | null; deltaCents: number; clamp: 'min' | 'max' | 'floor' | null; suppress: boolean; restore: boolean; currentlySuppressed: boolean }
interface EnfPlan { marketplace: string; month: string; capCents: number; mtdSpendCents: number; remainingBudgetCents: number; remainingDays: number; dayOfMonth: number; daysInMonth: number; autoPacing: boolean; stopOverSpend: boolean; capReached: boolean; todayTargetCents: number | null; campaigns: EnfCampaign[] }
export interface EnforcementResult { month: string; plans: EnfPlan[]; totals: { plans: number; budgetChanges: number; suppressing: number; restoring: number; netDeltaCents: number } }
interface HistEntry { id: string; at: string; actor: 'you' | 'automation'; entityId: string; field: string; oldValue: string | null; newValue: string | null; reason: string | null }
type AnyNode = (EnfCampaign & { kindType: 'campaign' }) | (OntoNode & { kindType: 'adgroup' | 'target' })

const API = () => getBackendUrl()
const eur = (c: number | null | undefined) => (c == null ? '—' : `€${(c / 100).toLocaleString('en-IE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`)
const FLAG: Record<string, string> = { IT: '🇮🇹', DE: '🇩🇪', FR: '🇫🇷', ES: '🇪🇸', GB: '🇬🇧', UK: '🇬🇧', NL: '🇳🇱', SE: '🇸🇪', PL: '🇵🇱', BE: '🇧🇪', IE: '🇮🇪' }
const MARKET_NAME: Record<string, string> = { IT: 'Italy', DE: 'Germany', FR: 'France', ES: 'Spain', GB: 'United Kingdom', UK: 'United Kingdom', NL: 'Netherlands', SE: 'Sweden', PL: 'Poland', BE: 'Belgium', IE: 'Ireland' }
const mkt = (m: string) => MARKET_NAME[m] ?? m
const parseEur = (s: string) => Math.max(0, Math.round((parseFloat(s.replace(',', '.')) || 0) * 100))
const fetchChildren = (parentType: string, parentId: string): Promise<OntoNode[]> => fetch(`${API()}/api/advertising/ontology/children?parentType=${parentType}&parentId=${encodeURIComponent(parentId)}`).then((r) => r.json()).then((j) => (Array.isArray(j?.children) ? j.children : [])).catch(() => [])

// ── P3 — named scenarios (localStorage) + compare ──────────────────────────
interface SavedScenario { id: string; name: string; changes: Record<string, StagedChange>; createdAt: number }
const SCEN_KEY = 'cp.scenarios.v1'
const loadScenarios = (): SavedScenario[] => { try { const a = JSON.parse(localStorage.getItem(SCEN_KEY) || '[]'); return Array.isArray(a) ? a : [] } catch { return [] } }
const saveScenarios = (s: SavedScenario[]) => { try { localStorage.setItem(SCEN_KEY, JSON.stringify(s)) } catch { /* quota */ } }
const genId = () => `scn_${Date.now().toString(36)}_${Math.floor(Math.random() * 1e6).toString(36)}`

function buildChanges(scenario: Record<string, StagedChange>, plans: EnfPlan[]): Array<Record<string, unknown>> {
  const changes: Array<Record<string, unknown>> = []
  for (const [id, s] of Object.entries(scenario)) {
    const et = s.entityType ?? 'campaign'
    if (et === 'campaign') {
      const mp = plans.find((p) => p.campaigns.some((c) => c.id === id))?.marketplace
      if (s.budgetCents != null) changes.push({ entityType: 'campaign', entityId: id, campaignId: id, kind: 'budget', budgetCents: s.budgetCents })
      if (s.minCents != null || s.maxCents != null) changes.push({ entityType: 'campaign', entityId: id, campaignId: id, marketplace: mp, kind: 'limit', minCents: s.minCents ?? null, maxCents: s.maxCents ?? null })
      if (s.suppress === true) changes.push({ entityType: 'campaign', entityId: id, campaignId: id, kind: 'suppress' })
      if (s.suppress === false) changes.push({ entityType: 'campaign', entityId: id, campaignId: id, kind: 'restore' })
      if (s.biddingStrategy) changes.push({ entityType: 'campaign', entityId: id, campaignId: id, kind: 'biddingStrategy', biddingStrategy: s.biddingStrategy })
      if (s.targetAcos != null) changes.push({ entityType: 'campaign', entityId: id, campaignId: id, kind: 'targetAcos', targetAcos: s.targetAcos })
      if (s.placements) changes.push({ entityType: 'campaign', entityId: id, campaignId: id, kind: 'placement', placements: s.placements })
    } else {
      if (s.bidCents != null) changes.push({ entityType: et, entityId: id, kind: et === 'adgroup' ? 'adgroupBid' : 'targetBid', bidCents: s.bidCents })
      if (s.status) changes.push({ entityType: et, entityId: id, kind: et === 'adgroup' ? 'adgroupStatus' : 'targetStatus', status: s.status })
    }
  }
  return changes
}
function summarizeStaged(s: StagedChange): string {
  const p: string[] = []
  if (s.budgetCents != null) p.push(`budget €${(s.budgetCents / 100).toFixed(2)}`)
  if (s.minCents != null || s.maxCents != null) p.push('min/max')
  if (s.suppress === true) p.push('suppress')
  if (s.suppress === false) p.push('restore')
  if (s.bidCents != null) p.push(`bid €${(s.bidCents / 100).toFixed(2)}`)
  if (s.status) p.push(s.status.toLowerCase())
  if (s.biddingStrategy) p.push(s.biddingStrategy === 'LEGACY_FOR_SALES' ? 'down-only' : s.biddingStrategy === 'AUTO_FOR_SALES' ? 'up&down' : 'fixed')
  if (s.targetAcos != null) p.push(`ACoS ${Math.round(s.targetAcos * 100)}%`)
  if (s.placements) p.push('placements')
  return p.join(', ') || '—'
}
function scenarioStats(scenario: Record<string, StagedChange>, allCamps: Map<string, EnfCampaign>) {
  let delta = 0
  for (const [id, s] of Object.entries(scenario)) if (s.budgetCents != null && (s.entityType ?? 'campaign') === 'campaign') { const c = allCamps.get(id); if (c) delta += s.budgetCents - c.currentDailyCents }
  return { count: Object.keys(scenario).length, delta, suppress: Object.values(scenario).filter((s) => s.suppress === true).length }
}

// ── Inspector — adapts to the selected object type ─────────────────────────
function Inspector({ node, rootCampaignId, staged, onStage, onClear, onClose }: { node: AnyNode; rootCampaignId: string | null; staged: StagedChange | undefined; onStage: (p: Partial<StagedChange>) => void; onClear: () => void; onClose: () => void }) {
  const t = node.kindType
  const camp = t === 'campaign' ? (node as EnfCampaign) : null
  const onto = t !== 'campaign' ? (node as OntoNode) : null
  const curBidCents = t === 'adgroup' ? (onto!.defaultBidCents ?? 0) : t === 'target' ? (onto!.bidCents ?? 0) : 0
  const [budget, setBudget] = useState(camp ? (staged?.budgetCents != null ? (staged.budgetCents / 100).toFixed(2) : (camp.currentDailyCents / 100).toFixed(2)) : '')
  const [min, setMin] = useState(staged?.minCents != null ? (staged.minCents / 100).toFixed(2) : '')
  const [max, setMax] = useState(staged?.maxCents != null ? (staged.maxCents / 100).toFixed(2) : '')
  const [bid, setBid] = useState(!camp ? (staged?.bidCents != null ? (staged.bidCents / 100).toFixed(2) : (curBidCents / 100).toFixed(2)) : '')
  const [history, setHistory] = useState<HistEntry[] | null>(null)
  useEffect(() => { let alive = true; if (!rootCampaignId) { setHistory([]); return } fetch(`${API()}/api/advertising/campaigns/${rootCampaignId}/history?limit=40`).then((r) => r.json()).then((j) => { if (alive) setHistory((Array.isArray(j?.entries) ? j.entries : []).filter((e: HistEntry) => e.entityId === node.id)) }).catch(() => { if (alive) setHistory([]) }); return () => { alive = false } }, [rootCampaignId, node.id])
  // P2 — campaign PPC settings (bidding strategy, target-ACoS, placement multipliers)
  const [settings, setSettings] = useState<{ biddingStrategy: string; targetAcos: number | null; placements: { tos: number | null; pdp: number | null; ros: number | null } } | null>(null)
  const [acos, setAcos] = useState('')
  const [pl, setPl] = useState({ tos: '', pdp: '', ros: '' })
  useEffect(() => { if (!camp) { setSettings(null); return } let alive = true; fetch(`${API()}/api/advertising/campaigns/${node.id}/settings`).then((r) => r.json()).then((j) => { if (alive) setSettings(j) }).catch(() => { if (alive) setSettings(null) }); return () => { alive = false } }, [camp, node.id])
  useEffect(() => { if (!settings) return; setAcos(staged?.targetAcos != null ? Math.round(staged.targetAcos * 100).toString() : (settings.targetAcos != null ? Math.round(settings.targetAcos * 100).toString() : '')); const sp = staged?.placements; const gp = settings.placements ?? { tos: null, pdp: null, ros: null }; setPl({ tos: String((sp?.tos ?? gp.tos) ?? ''), pdp: String((sp?.pdp ?? gp.pdp) ?? ''), ros: String((sp?.ros ?? gp.ros) ?? '') }) }, [settings]) // eslint-disable-line react-hooks/exhaustive-deps
  const STRAT: Array<[string, string]> = [['LEGACY_FOR_SALES', 'Down only'], ['AUTO_FOR_SALES', 'Up & Down'], ['MANUAL', 'Fixed']]
  const effStrat = staged?.biddingStrategy ?? settings?.biddingStrategy
  const stageStrat = (s: string) => onStage({ entityType: 'campaign', biddingStrategy: s === settings?.biddingStrategy ? undefined : s })
  const stageAcos = (v: string) => { setAcos(v); onStage({ entityType: 'campaign', targetAcos: v.trim() === '' ? undefined : (parseFloat(v) || 0) / 100 }) }
  const stagePl = (key: 'tos' | 'pdp' | 'ros', v: string) => { const next = { ...pl, [key]: v }; setPl(next); onStage({ entityType: 'campaign', placements: { tos: next.tos === '' ? null : Number(next.tos), pdp: next.pdp === '' ? null : Number(next.pdp), ros: next.ros === '' ? null : Number(next.ros) } }) }

  // campaign actions
  const effSuppress = camp ? (staged?.suppress != null ? staged.suppress : camp.currentlySuppressed) : false
  const stageBudget = (v: string) => { setBudget(v); onStage({ entityType: 'campaign', budgetCents: v.trim() === '' ? undefined : parseEur(v) }) }
  const stageMin = (v: string) => { setMin(v); onStage({ entityType: 'campaign', minCents: v.trim() === '' ? undefined : parseEur(v) }) }
  const stageMax = (v: string) => { setMax(v); onStage({ entityType: 'campaign', maxCents: v.trim() === '' ? undefined : parseEur(v) }) }
  const pin = () => { if (!camp) return; const v = (camp.currentDailyCents / 100).toFixed(2); setBudget(v); setMin(v); setMax(v); onStage({ entityType: 'campaign', budgetCents: camp.currentDailyCents, minCents: camp.currentDailyCents, maxCents: camp.currentDailyCents }) }
  const toggleSuppress = () => { if (!camp) return; const next = !effSuppress; onStage({ entityType: 'campaign', suppress: next === camp.currentlySuppressed ? undefined : next }) }
  // adgroup/target actions
  const effStatus = (staged?.status ?? onto?.status ?? 'ENABLED') as string
  const stageBid = (v: string) => { setBid(v); onStage({ entityType: t, bidCents: v.trim() === '' ? undefined : parseEur(v) }) }
  const stageStatus = (next: 'ENABLED' | 'PAUSED' | 'ARCHIVED') => onStage({ entityType: t, status: next === onto?.status ? undefined : next })

  const typeLabel = t === 'campaign' ? 'Campaign' : t === 'adgroup' ? 'Ad group' : 'Target'
  return (
    <aside className="cp-insp">
      <div className="cp-insp-h"><span className="ttl"><span className="ty">{typeLabel}</span><b title={node.name}>{node.name}</b></span><button type="button" className="x" aria-label="Close inspector" onClick={onClose}>×</button></div>
      <div className="cp-insp-kpis">
        {camp ? <>
          <span><i>Current</i>{eur(camp.currentDailyCents)}/day</span>
          <span><i>Paced target</i>{camp.targetDailyCents != null ? `${eur(camp.targetDailyCents)}/day` : '—'}</span>
          <span><i>Status</i>{camp.currentlySuppressed ? 'Suppressed' : 'Active'}</span>
        </> : <>
          <span><i>{t === 'adgroup' ? 'Default bid' : 'Bid'}</i>{eur(curBidCents)}</span>
          <span><i>{t === 'adgroup' ? 'Targeting' : 'Match'}</i>{t === 'adgroup' ? (onto!.targetingType ?? 'MANUAL') : (onto!.expressionType ?? onto!.kind ?? '—')}</span>
          <span><i>Spend</i>{eur(onto!.spendCents)}</span>
          <span><i>Status</i>{onto!.status}</span>
        </>}
      </div>

      <div className="cp-insp-sec">
        {camp ? <>
          <label className="cp-fld"><span>Daily budget</span><span className="cp-eurin"><i>€</i><input inputMode="decimal" value={budget} onChange={(e) => stageBudget(e.target.value)} aria-label="Daily budget" /></span></label>
          <div className="cp-fld2">
            <label className="cp-fld"><span>Min €/day</span><span className="cp-eurin"><i>€</i><input inputMode="decimal" placeholder="—" value={min} onChange={(e) => stageMin(e.target.value)} aria-label="Min daily" /></span></label>
            <label className="cp-fld"><span>Max €/day</span><span className="cp-eurin"><i>€</i><input inputMode="decimal" placeholder="—" value={max} onChange={(e) => stageMax(e.target.value)} aria-label="Max daily" /></span></label>
          </div>
          <div className="cp-insp-actions">
            <button type="button" className="cp-act" onClick={pin}><Lock size={12} /> Pin budget</button>
            <button type="button" className={`cp-act ${effSuppress ? 'on' : ''}`} onClick={toggleSuppress}>{effSuppress ? 'Restore bids' : 'Suppress (bid floor)'}</button>
          </div>
        </> : <>
          <label className="cp-fld"><span>{t === 'adgroup' ? 'Default bid' : 'Bid'} €</span><span className="cp-eurin"><i>€</i><input inputMode="decimal" value={bid} onChange={(e) => stageBid(e.target.value)} aria-label="Bid" /></span></label>
          <div className="cp-fld"><span>Status</span><div className="cp-statusbtns">{(['ENABLED', 'PAUSED', 'ARCHIVED'] as const).map((s) => (<button type="button" key={s} className={effStatus === s ? 'on' : ''} onClick={() => stageStatus(s)}>{s === 'ENABLED' ? 'Enable' : s === 'PAUSED' ? 'Pause' : 'Archive'}</button>))}</div></div>
        </>}
        {staged && <button type="button" className="cp-clear" onClick={() => { onClear(); setBudget(camp ? (camp.currentDailyCents / 100).toFixed(2) : ''); setMin(''); setMax(''); setBid(!camp ? (curBidCents / 100).toFixed(2) : '') }}>Clear staged change</button>}
      </div>

      {camp && settings && (
        <div className="cp-insp-sec">
          <div className="cp-sec-h">Bidding</div>
          <div className="cp-fld"><span>Strategy</span><div className="cp-statusbtns">{STRAT.map(([v, l]) => (<button type="button" key={v} className={effStrat === v ? 'on' : ''} onClick={() => stageStrat(v)}>{l}</button>))}</div></div>
          <label className="cp-fld"><span>Target ACoS</span><span className="cp-eurin pct"><input inputMode="decimal" value={acos} onChange={(e) => stageAcos(e.target.value)} placeholder="—" aria-label="Target ACoS" /><i>%</i></span></label>
          <div className="cp-fld"><span>Placement multipliers</span><div className="cp-pl3">
            {(['tos', 'pdp', 'ros'] as const).map((k) => (<label key={k}><span>{k === 'tos' ? 'ToS' : k === 'pdp' ? 'PDP' : 'RoS'}</span><span className="cp-plin"><input inputMode="decimal" value={pl[k]} onChange={(e) => stagePl(k, e.target.value)} placeholder="0" aria-label={`${k} multiplier`} /><i>%</i></span></label>))}
          </div></div>
        </div>
      )}

      <div className="cp-insp-sec">
        <div className="cp-sec-h"><HistoryIcon size={12} /> Recent changes</div>
        {history == null ? <div className="cp-prov-load">Loading…</div>
          : history.length === 0 ? <div className="cp-prov-empty">No recorded changes yet.</div>
          : <div className="cp-prov">{history.slice(0, 10).map((h) => (
              <div className="cp-prov-row" key={h.id}>
                <span className="f">{h.field}</span><span className="v">{h.oldValue ?? '—'} → {h.newValue ?? '—'}</span>
                <span className="m">{h.actor === 'automation' ? 'auto' : 'you'}{h.reason ? ` · ${h.reason}` : ''}</span>
              </div>))}</div>}
      </div>
    </aside>
  )
}

// ── P4a — bulk actions on a multi-selection ────────────────────────────────
function BulkPanel({ refs, allCamps, adGroups, targets, onStageMany, onClear }: { refs: Array<{ id: string; type: 'campaign' | 'adgroup' | 'target' }>; allCamps: Map<string, EnfCampaign>; adGroups: OntoNode[] | null; targets: OntoNode[] | null; onStageMany: (u: Array<{ id: string; patch: Partial<StagedChange> }>) => void; onClear: () => void }) {
  const camps = refs.filter((r) => r.type === 'campaign')
  const childRefs = refs.filter((r) => r.type !== 'campaign')
  const nAg = childRefs.filter((r) => r.type === 'adgroup').length
  const nTg = childRefs.filter((r) => r.type === 'target').length
  const [budgetPct, setBudgetPct] = useState('10')
  const [bidPct, setBidPct] = useState('10')
  const keep = <T,>(x: T | null): x is T => x != null
  const bulkBudget = (sign: number) => { const p = (parseFloat(budgetPct) || 0) / 100; onStageMany(camps.map((r) => { const c = allCamps.get(r.id); return c ? { id: r.id, patch: { entityType: 'campaign' as const, budgetCents: Math.max(100, Math.round(c.currentDailyCents * (1 + sign * p))) } } : null }).filter(keep)) }
  const bulkSuppress = (v: boolean) => onStageMany(camps.map((r) => ({ id: r.id, patch: { entityType: 'campaign' as const, suppress: v } })))
  const bulkBid = (sign: number) => { const p = (parseFloat(bidPct) || 0) / 100; onStageMany(childRefs.map((r) => { const cur = r.type === 'adgroup' ? adGroups?.find((g) => g.id === r.id)?.defaultBidCents : targets?.find((t) => t.id === r.id)?.bidCents; return cur == null ? null : { id: r.id, patch: { entityType: r.type, bidCents: Math.max(2, Math.round(cur * (1 + sign * p))) } } }).filter(keep)) }
  const bulkStatus = (status: 'ENABLED' | 'PAUSED') => onStageMany(childRefs.map((r) => ({ id: r.id, patch: { entityType: r.type, status } })))
  return (
    <aside className="cp-insp cp-bulk">
      <div className="cp-insp-h"><span className="ttl"><span className="ty">Bulk</span><b>{refs.length} selected</b></span><button type="button" className="x" aria-label="Clear selection" onClick={onClear}>×</button></div>
      <div className="cp-bulk-counts">{camps.length > 0 && <span>{camps.length} campaign{camps.length === 1 ? '' : 's'}</span>}{nAg > 0 && <span>{nAg} ad group{nAg === 1 ? '' : 's'}</span>}{nTg > 0 && <span>{nTg} target{nTg === 1 ? '' : 's'}</span>}</div>
      {camps.length > 0 && (
        <div className="cp-insp-sec">
          <div className="cp-sec-h">Campaigns</div>
          <div className="cp-bulk-row"><span>Budget</span><span className="cp-eurin pct"><input inputMode="decimal" value={budgetPct} onChange={(e) => setBudgetPct(e.target.value)} aria-label="Budget percent" /><i>%</i></span><button type="button" className="cp-act" onClick={() => bulkBudget(1)}>Raise</button><button type="button" className="cp-act" onClick={() => bulkBudget(-1)}>Lower</button></div>
          <div className="cp-insp-actions"><button type="button" className="cp-act" onClick={() => bulkSuppress(true)}>Suppress all</button><button type="button" className="cp-act" onClick={() => bulkSuppress(false)}>Restore all</button></div>
        </div>
      )}
      {childRefs.length > 0 && (
        <div className="cp-insp-sec">
          <div className="cp-sec-h">Ad groups &amp; targets</div>
          <div className="cp-bulk-row"><span>Bid</span><span className="cp-eurin pct"><input inputMode="decimal" value={bidPct} onChange={(e) => setBidPct(e.target.value)} aria-label="Bid percent" /><i>%</i></span><button type="button" className="cp-act" onClick={() => bulkBid(1)}>Raise</button><button type="button" className="cp-act" onClick={() => bulkBid(-1)}>Lower</button></div>
          <div className="cp-insp-actions"><button type="button" className="cp-act" onClick={() => bulkStatus('ENABLED')}>Enable all</button><button type="button" className="cp-act" onClick={() => bulkStatus('PAUSED')}>Pause all</button></div>
        </div>
      )}
      <div className="cp-bulk-hint">⌘/Ctrl/Shift-click nodes to add or remove. Bulk edits stage like any other change — review &amp; commit below.</div>
    </aside>
  )
}

// ── P3 — compare two scenarios side-by-side ────────────────────────────────
function ComparePanel({ working, workingName, saved, compareId, setCompareId, allCamps, committing, onCommit }: { working: Record<string, StagedChange>; workingName: string; saved: SavedScenario[]; compareId: string; setCompareId: (id: string) => void; allCamps: Map<string, EnfCampaign>; committing: boolean; onCommit: (changes: Record<string, StagedChange>, isWorking: boolean) => void }) {
  const right = saved.find((s) => s.id === compareId)
  const cols: Array<{ key: string; name: string; changes: Record<string, StagedChange>; isWorking: boolean }> = [{ key: 'working', name: workingName, changes: working, isWorking: true }, ...(right ? [{ key: right.id, name: right.name, changes: right.changes, isWorking: false }] : [])]
  return (
    <div className="cp-compare">
      <div className="cp-compare-pick"><span>Compare the working set against</span><select value={compareId} onChange={(e) => setCompareId(e.target.value)}>{saved.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select></div>
      <div className="cp-compare-cols">
        {cols.map((col) => {
          const st = scenarioStats(col.changes, allCamps)
          const rows = Object.entries(col.changes)
          return (
            <div className="cp-compare-col" key={col.key}>
              <div className="hd"><b>{col.name}</b><span className="st">{st.count} change{st.count === 1 ? '' : 's'}{st.delta !== 0 ? ` · daily ${st.delta > 0 ? '+' : ''}${eur(st.delta)}` : ''}{st.suppress ? ` · ${st.suppress} suppress` : ''}</span></div>
              <div className="rows">{rows.length === 0 ? <div className="empty">No changes.</div> : rows.map(([id, s]) => { const c = allCamps.get(id); const name = c ? c.name : `${s.entityType ?? 'campaign'} ·${id.slice(-6)}`; return <div className="row" key={id}><span className="nm" title={name}>{name}</span><span className="ch">{summarizeStaged(s)}</span></div> })}</div>
              <button type="button" className="h10-am-btn primary" disabled={committing || st.count === 0} onClick={() => onCommit(col.changes, col.isWorking)}>Commit this</button>
            </div>
          )
        })}
      </div>
    </div>
  )
}

export function ControlPlane({ open, onClose, enforcement, month, initialMarket, onCommitted, toast }: { open: boolean; onClose: () => void; enforcement: EnforcementResult | null; month: string; initialMarket: string; onCommitted: () => void; toast: (m: string) => void }) {
  const [market, setMarket] = useState(initialMarket)
  const [sel, setSel] = useState<SelectRef>(null)
  const [scenario, setScenario] = useState<Record<string, StagedChange>>({})
  const [committing, setCommitting] = useState(false)
  const [focusCampaign, setFocusCampaign] = useState<string | null>(null)
  const [focusAdGroup, setFocusAdGroup] = useState<string | null>(null)
  const [adGroups, setAdGroups] = useState<OntoNode[] | null>(null)
  const [targets, setTargets] = useState<OntoNode[] | null>(null)
  const [saved, setSaved] = useState<SavedScenario[]>([])
  const [activeId, setActiveId] = useState<string | null>(null)
  const [compareId, setCompareId] = useState<string | null>(null)
  const [multi, setMulti] = useState<Array<{ id: string; type: 'campaign' | 'adgroup' | 'target' }>>([])
  useEffect(() => { if (open) { setMarket(initialMarket); setSel(null); setMulti([]); setFocusCampaign(null); setFocusAdGroup(null); setAdGroups(null); setTargets(null); setSaved(loadScenarios()); setCompareId(null) } }, [open, initialMarket])

  const plan = useMemo(() => enforcement?.plans.find((p) => p.marketplace === market) ?? enforcement?.plans[0] ?? null, [enforcement, market])
  const allCamps = useMemo(() => { const m = new Map<string, EnfCampaign>(); for (const p of enforcement?.plans ?? []) for (const c of p.campaigns) m.set(c.id, c); return m }, [enforcement])

  const selectedNode: AnyNode | null = useMemo(() => {
    if (!sel) return null
    if (sel.type === 'campaign') { const c = plan?.campaigns.find((x) => x.id === sel.id); return c ? { ...c, kindType: 'campaign' } : null }
    if (sel.type === 'adgroup') { const g = adGroups?.find((x) => x.id === sel.id); return g ? { ...g, kindType: 'adgroup' } : null }
    const tg = targets?.find((x) => x.id === sel.id); return tg ? { ...tg, kindType: 'target' } : null
  }, [sel, plan, adGroups, targets])

  const onSelect = async (ref: SelectRef, additive?: boolean) => {
    if (!ref) { setSel(null); setMulti([]); return }
    if (additive) { setSel(null); setMulti((prev) => (prev.some((m) => m.id === ref.id) ? prev.filter((m) => m.id !== ref.id) : [...prev, ref])); return }
    setMulti([]); setSel(ref)
    if (ref.type === 'campaign') { setFocusCampaign(ref.id); setFocusAdGroup(null); setTargets(null); setAdGroups(null); setAdGroups(await fetchChildren('campaign', ref.id)) }
    else if (ref.type === 'adgroup') { setFocusAdGroup(ref.id); setTargets(null); setTargets(await fetchChildren('adgroup', ref.id)) }
  }

  const stageCount = Object.keys(scenario).length
  const projectedDelta = useMemo(() => { let d = 0; for (const [id, s] of Object.entries(scenario)) { if (s.budgetCents != null && (s.entityType ?? 'campaign') === 'campaign') { const c = allCamps.get(id); if (c) d += s.budgetCents - c.currentDailyCents } } return d }, [scenario, allCamps])
  const suppressCount = Object.values(scenario).filter((s) => s.suppress === true).length

  const setStage = (id: string, patch: Partial<StagedChange>) => setScenario((prev) => {
    const merged: Record<string, unknown> = { ...prev[id], ...patch }
    for (const k of Object.keys(merged)) if (merged[k] === undefined) delete merged[k]
    const next = { ...prev }
    const meaningful = ['budgetCents', 'minCents', 'maxCents', 'suppress', 'bidCents', 'status', 'biddingStrategy', 'targetAcos', 'placements'].some((k) => merged[k] !== undefined)
    if (!meaningful) delete next[id]; else next[id] = merged as StagedChange
    return next
  })
  const clearStage = (id: string) => setScenario((prev) => { const n = { ...prev }; delete n[id]; return n })
  const setStageMany = (updates: Array<{ id: string; patch: Partial<StagedChange> }>) => setScenario((prev) => {
    const next = { ...prev }
    for (const u of updates) {
      const merged: Record<string, unknown> = { ...next[u.id], ...u.patch }
      for (const k of Object.keys(merged)) if (merged[k] === undefined) delete merged[k]
      const meaningful = ['budgetCents', 'minCents', 'maxCents', 'suppress', 'bidCents', 'status', 'biddingStrategy', 'targetAcos', 'placements'].some((k) => merged[k] !== undefined)
      if (!meaningful) delete next[u.id]; else next[u.id] = merged as StagedChange
    }
    return next
  })
  const stagedInMarket = (p: EnfPlan) => p.campaigns.filter((c) => scenario[c.id]).length

  const commitChanges = async (changesMap: Record<string, StagedChange>, isWorking: boolean) => {
    const changes = buildChanges(changesMap, enforcement?.plans ?? [])
    if (changes.length === 0) return
    setCommitting(true)
    try {
      const r = await fetch(`${API()}/api/advertising/budget-manager/scenario/commit`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ month, changes }) }).then((x) => x.json())
      if (r?.ok) { toast(`Committed ${r.applied} change${r.applied === 1 ? '' : 's'} · undo within 5 min`); if (isWorking) { setScenario({}); setActiveId(null) } setSel(null); setCompareId(null); onCommitted() }
      else { toast(`Committed ${r?.applied ?? 0}, ${r?.failed ?? 0} failed`); onCommitted() }
    } catch { toast('Commit failed') } finally { setCommitting(false) }
  }
  const commit = () => commitChanges(scenario, true)
  // P3 — scenario manager (localStorage-backed)
  const persistAndSet = (next: SavedScenario[]) => { setSaved(next); saveScenarios(next) }
  const saveScenarioAs = () => { if (stageCount === 0) return; const name = window.prompt('Name this scenario:', `Scenario ${saved.length + 1}`); if (!name) return; const id = genId(); persistAndSet([...saved, { id, name, changes: scenario, createdAt: Date.now() }]); setActiveId(id); toast(`Saved “${name.trim()}”`) }
  const updateActiveScenario = () => { if (!activeId) return; persistAndSet(saved.map((s) => (s.id === activeId ? { ...s, changes: scenario } : s))); toast('Scenario updated') }
  const loadScenario = (id: string) => { const s = saved.find((x) => x.id === id); if (!s) return; if (activeId == null && stageCount > 0 && !window.confirm('Discard the unsaved working set?')) return; setScenario({ ...s.changes }); setActiveId(id); setSel(null) }
  const newScenario = () => { if (stageCount > 0 && activeId == null && !window.confirm('Discard the unsaved working set?')) return; setScenario({}); setActiveId(null); setSel(null) }
  const delScenario = (id: string) => { persistAndSet(saved.filter((s) => s.id !== id)); if (activeId === id) setActiveId(null); if (compareId === id) setCompareId(null) }
  // P4b — promote the scenario's mappable campaign actions into a standing rule
  // (SCHEDULE-triggered, disabled + dry-run; refine in Rules & Automation).
  const promoteToRule = async () => {
    const actions: Array<Record<string, unknown>> = []
    let skipped = 0
    for (const [id, s] of Object.entries(scenario)) {
      if ((s.entityType ?? 'campaign') === 'campaign') {
        if (s.budgetCents != null) actions.push({ type: 'set_daily_budget', budgetEur: s.budgetCents / 100, campaignId: id })
        if (s.targetAcos != null) actions.push({ type: 'set_campaign_target_acos', targetAcos: s.targetAcos, campaignId: id })
        if (s.placements) (([['tos', 'PLACEMENT_TOP'], ['pdp', 'PLACEMENT_PRODUCT_PAGE'], ['ros', 'PLACEMENT_REST_OF_SEARCH']]) as Array<['tos' | 'pdp' | 'ros', string]>).forEach(([k, plc]) => { const v = s.placements?.[k]; if (v != null) actions.push({ type: 'set_placement_multiplier', placement: plc, percentage: v, campaignId: id }) })
        if (s.minCents != null || s.maxCents != null || s.suppress != null || s.biddingStrategy != null) skipped++
      } else skipped++
    }
    if (actions.length === 0) { toast('Nothing promotable — rules support campaign budget, target-ACoS and placement.'); return }
    const name = window.prompt('Name the rule:', (activeId && saved.find((s) => s.id === activeId)?.name) || 'Control Plane rule')
    if (!name) return
    try {
      const r = await fetch(`${API()}/api/advertising/automation-rules`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name, description: 'Created from a Control Plane scenario', trigger: 'SCHEDULE', actions }) }).then((x) => x.json())
      if (r?.id || r?.rule?.id) toast(`Rule “${name}” created — disabled & dry-run${skipped ? `, ${skipped} non-promotable skipped` : ''}. Refine it in Rules & Automation.`)
      else toast('Rule creation failed.')
    } catch { toast('Rule creation failed.') }
  }

  const tryClose = () => { if (stageCount > 0 && !window.confirm(`Discard ${stageCount} staged change${stageCount === 1 ? '' : 's'}?`)) return; setScenario({}); onClose() }
  const rootCampaignId = sel?.type === 'campaign' ? sel.id : focusCampaign

  if (!open) return null
  return (
    <Modal open onClose={tryClose} size="xl" title="Budget Control Plane" subtitle="Drill the ontology — market → campaigns → ad groups → targets. Stage changes, review, then commit — gated, audited, reversible."
      footer={(
        <div className="cp-review">
          <span className="sum">{stageCount === 0 ? 'No staged changes' : (<><b>{stageCount} staged change{stageCount === 1 ? '' : 's'}</b>{projectedDelta !== 0 ? <> · daily <em className={projectedDelta > 0 ? 'up' : 'down'}>{projectedDelta > 0 ? '+' : ''}{eur(projectedDelta)}</em></> : null}{suppressCount > 0 ? <> · {suppressCount} suppress</> : null}</>)}</span>
          <span className="grow" />
          <button type="button" className="h10-am-btn" disabled={!stageCount || committing} onClick={() => setScenario({})}>Discard</button>
          <button type="button" className="h10-am-btn primary" disabled={!stageCount || committing} onClick={commit}>{committing ? 'Committing…' : `Commit${stageCount ? ` ${stageCount}` : ''}`}</button>
        </div>
      )}>
      {!enforcement || enforcement.plans.length === 0 ? (
        <div className="cp-empty">No markets have Auto Pacing or Stop Over Spend enabled this month. Turn one on (the row toggles) to load the control plane.</div>
      ) : (
        <>
          <div className="cp-scenbar">
            <span className="lbl">Scenario</span>
            <button type="button" className={`cp-scenchip ${!activeId ? 'on' : ''}`} onClick={newScenario}>Working set{!activeId && stageCount ? ` · ${stageCount}` : ''}</button>
            {saved.map((s) => (
              <span key={s.id} className={`cp-scenchip wrap ${activeId === s.id ? 'on' : ''}`}>
                <button type="button" onClick={() => loadScenario(s.id)}>{s.name} · {Object.keys(s.changes).length}</button>
                <button type="button" className="x" aria-label={`Delete ${s.name}`} onClick={() => delScenario(s.id)}>×</button>
              </span>
            ))}
            <span className="grow" />
            {activeId && <button type="button" className="h10-am-btn" disabled={!stageCount} onClick={updateActiveScenario}>Update</button>}
            <button type="button" className="h10-am-btn" disabled={!stageCount} onClick={saveScenarioAs}>Save as…</button>
            <button type="button" className="h10-am-btn" disabled={!stageCount} onClick={promoteToRule}>Save as rule</button>
            {saved.length > 0 && <button type="button" className="h10-am-btn" onClick={() => setCompareId(compareId ? null : saved[0].id)}>{compareId ? 'Close compare' : '⇄ Compare'}</button>}
          </div>
          {compareId ? (
            <ComparePanel working={scenario} workingName={activeId ? `${saved.find((s) => s.id === activeId)?.name ?? 'Working'} (active)` : 'Working set'} saved={saved} compareId={compareId} setCompareId={setCompareId} allCamps={allCamps} committing={committing} onCommit={commitChanges} />
          ) : (
            <div className="cp-layout">
              <div className="cp-main">
                <div className="cp-tabs">
                  {enforcement.plans.map((p) => (
                    <button type="button" key={p.marketplace} className={`cp-tab ${market === p.marketplace ? 'on' : ''}`} onClick={() => { setMarket(p.marketplace); setSel(null); setMulti([]); setFocusCampaign(null); setFocusAdGroup(null); setAdGroups(null); setTargets(null) }}>{FLAG[p.marketplace] ?? '🌐'} {mkt(p.marketplace)}{stagedInMarket(p) > 0 ? <em className="dot"> ●</em> : null}</button>
                  ))}
                  <span className="grow" />
                  <span className="cp-hint">Click a node to inspect · ⌘-click to multi-select · campaigns &amp; ad groups drill in</span>
                </div>
                {plan && <AllocationCanvas plan={plan} selectedId={sel?.id ?? null} onSelect={onSelect} staged={scenario} adGroups={adGroups} targets={targets} focusCampaign={focusCampaign} focusAdGroup={focusAdGroup} multiSelected={new Set(multi.map((m) => m.id))} />}
              </div>
              {multi.length > 0 ? <BulkPanel refs={multi} allCamps={allCamps} adGroups={adGroups} targets={targets} onStageMany={setStageMany} onClear={() => setMulti([])} /> : selectedNode && <Inspector key={selectedNode.id} node={selectedNode} rootCampaignId={rootCampaignId} staged={scenario[selectedNode.id]} onStage={(p) => setStage(selectedNode.id, p)} onClear={() => clearStage(selectedNode.id)} onClose={() => setSel(null)} />}
            </div>
          )}
        </>
      )}
    </Modal>
  )
}
