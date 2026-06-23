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

export function ControlPlane({ open, onClose, enforcement, month, initialMarket, onCommitted, toast }: { open: boolean; onClose: () => void; enforcement: EnforcementResult | null; month: string; initialMarket: string; onCommitted: () => void; toast: (m: string) => void }) {
  const [market, setMarket] = useState(initialMarket)
  const [sel, setSel] = useState<SelectRef>(null)
  const [scenario, setScenario] = useState<Record<string, StagedChange>>({})
  const [committing, setCommitting] = useState(false)
  const [focusCampaign, setFocusCampaign] = useState<string | null>(null)
  const [focusAdGroup, setFocusAdGroup] = useState<string | null>(null)
  const [adGroups, setAdGroups] = useState<OntoNode[] | null>(null)
  const [targets, setTargets] = useState<OntoNode[] | null>(null)
  useEffect(() => { if (open) { setMarket(initialMarket); setSel(null); setFocusCampaign(null); setFocusAdGroup(null); setAdGroups(null); setTargets(null) } }, [open, initialMarket])

  const plan = useMemo(() => enforcement?.plans.find((p) => p.marketplace === market) ?? enforcement?.plans[0] ?? null, [enforcement, market])
  const allCamps = useMemo(() => { const m = new Map<string, EnfCampaign>(); for (const p of enforcement?.plans ?? []) for (const c of p.campaigns) m.set(c.id, c); return m }, [enforcement])

  const selectedNode: AnyNode | null = useMemo(() => {
    if (!sel) return null
    if (sel.type === 'campaign') { const c = plan?.campaigns.find((x) => x.id === sel.id); return c ? { ...c, kindType: 'campaign' } : null }
    if (sel.type === 'adgroup') { const g = adGroups?.find((x) => x.id === sel.id); return g ? { ...g, kindType: 'adgroup' } : null }
    const tg = targets?.find((x) => x.id === sel.id); return tg ? { ...tg, kindType: 'target' } : null
  }, [sel, plan, adGroups, targets])

  const onSelect = async (ref: SelectRef) => {
    setSel(ref)
    if (!ref) return
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
    const meaningful = ['budgetCents', 'minCents', 'maxCents', 'suppress', 'bidCents', 'status'].some((k) => merged[k] !== undefined)
    if (!meaningful) delete next[id]; else next[id] = merged as StagedChange
    return next
  })
  const clearStage = (id: string) => setScenario((prev) => { const n = { ...prev }; delete n[id]; return n })
  const stagedInMarket = (p: EnfPlan) => p.campaigns.filter((c) => scenario[c.id]).length

  const commit = async () => {
    if (stageCount === 0) return
    setCommitting(true)
    const changes: Array<Record<string, unknown>> = []
    for (const [id, s] of Object.entries(scenario)) {
      const et = s.entityType ?? 'campaign'
      if (et === 'campaign') {
        const mp = [...(enforcement?.plans ?? [])].find((p) => p.campaigns.some((c) => c.id === id))?.marketplace
        if (s.budgetCents != null) changes.push({ entityType: 'campaign', entityId: id, campaignId: id, kind: 'budget', budgetCents: s.budgetCents })
        if (s.minCents != null || s.maxCents != null) changes.push({ entityType: 'campaign', entityId: id, campaignId: id, marketplace: mp, kind: 'limit', minCents: s.minCents ?? null, maxCents: s.maxCents ?? null })
        if (s.suppress === true) changes.push({ entityType: 'campaign', entityId: id, campaignId: id, kind: 'suppress' })
        if (s.suppress === false) changes.push({ entityType: 'campaign', entityId: id, campaignId: id, kind: 'restore' })
      } else {
        if (s.bidCents != null) changes.push({ entityType: et, entityId: id, kind: et === 'adgroup' ? 'adgroupBid' : 'targetBid', bidCents: s.bidCents })
        if (s.status) changes.push({ entityType: et, entityId: id, kind: et === 'adgroup' ? 'adgroupStatus' : 'targetStatus', status: s.status })
      }
    }
    try {
      const r = await fetch(`${API()}/api/advertising/budget-manager/scenario/commit`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ month, changes }) }).then((x) => x.json())
      if (r?.ok) { toast(`Committed ${r.applied} change${r.applied === 1 ? '' : 's'} · undo within 5 min`); setScenario({}); setSel(null); onCommitted() }
      else { toast(`Committed ${r?.applied ?? 0}, ${r?.failed ?? 0} failed`); onCommitted() }
    } catch { toast('Commit failed') } finally { setCommitting(false) }
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
        <div className="cp-layout">
          <div className="cp-main">
            <div className="cp-tabs">
              {enforcement.plans.map((p) => (
                <button type="button" key={p.marketplace} className={`cp-tab ${market === p.marketplace ? 'on' : ''}`} onClick={() => { setMarket(p.marketplace); setSel(null); setFocusCampaign(null); setFocusAdGroup(null); setAdGroups(null); setTargets(null) }}>{FLAG[p.marketplace] ?? '🌐'} {mkt(p.marketplace)}{stagedInMarket(p) > 0 ? <em className="dot"> ●</em> : null}</button>
              ))}
              <span className="grow" />
              <span className="cp-hint">Click a node to inspect · campaigns &amp; ad groups drill in</span>
            </div>
            {plan && <AllocationCanvas plan={plan} selectedId={sel?.id ?? null} onSelect={onSelect} staged={scenario} adGroups={adGroups} targets={targets} focusCampaign={focusCampaign} focusAdGroup={focusAdGroup} />}
          </div>
          {selectedNode && <Inspector key={selectedNode.id} node={selectedNode} rootCampaignId={rootCampaignId} staged={scenario[selectedNode.id]} onStage={(p) => setStage(selectedNode.id, p)} onClear={() => clearStage(selectedNode.id)} onClose={() => setSel(null)} />}
        </div>
      )}
    </Modal>
  )
}
