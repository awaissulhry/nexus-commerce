'use client'

/**
 * CP.2 + CP.3 + CP.4 — Budget Control Plane. The Allocation Map grown into an
 * operational surface: select a campaign node on the canvas → an Inspector with
 * action controls (daily budget · min/max · pin/lock · suppress/restore) that
 * STAGE changes into a client-side scenario (nothing applied yet). A review bar
 * shows the staged batch + projected daily-budget Δ; Commit pushes the batch
 * through the gated + audited POST /scenario/commit (5-min grace undo). The
 * Inspector also shows each object's provenance (recent CampaignBidHistory).
 *
 * Palantir-style scenario → review → commit, scoped to budget for v1; the same
 * architecture generalises to the full ad ontology later.
 */
import { useEffect, useMemo, useState } from 'react'
import { Lock, History as HistoryIcon } from 'lucide-react'
import { Modal } from '@/design-system/components'
import { AllocationCanvas, type StagedChange } from './AllocationCanvas'
import { getBackendUrl } from '@/lib/backend-url'
import './control-plane.css'

interface EnfCampaign { id: string; name: string; currentDailyCents: number; targetDailyCents: number | null; deltaCents: number; clamp: 'min' | 'max' | 'floor' | null; suppress: boolean; restore: boolean; currentlySuppressed: boolean }
interface EnfPlan { marketplace: string; month: string; capCents: number; mtdSpendCents: number; remainingBudgetCents: number; remainingDays: number; dayOfMonth: number; daysInMonth: number; autoPacing: boolean; stopOverSpend: boolean; capReached: boolean; todayTargetCents: number | null; campaigns: EnfCampaign[] }
export interface EnforcementResult { month: string; plans: EnfPlan[]; totals: { plans: number; budgetChanges: number; suppressing: number; restoring: number; netDeltaCents: number } }
interface HistEntry { id: string; at: string; actor: 'you' | 'automation'; field: string; oldValue: string | null; newValue: string | null; reason: string | null }

const API = () => getBackendUrl()
const eur = (c: number | null | undefined) => (c == null ? '—' : `€${(c / 100).toLocaleString('en-IE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`)
const FLAG: Record<string, string> = { IT: '🇮🇹', DE: '🇩🇪', FR: '🇫🇷', ES: '🇪🇸', GB: '🇬🇧', UK: '🇬🇧', NL: '🇳🇱', SE: '🇸🇪', PL: '🇵🇱', BE: '🇧🇪', IE: '🇮🇪' }
const MARKET_NAME: Record<string, string> = { IT: 'Italy', DE: 'Germany', FR: 'France', ES: 'Spain', GB: 'United Kingdom', UK: 'United Kingdom', NL: 'Netherlands', SE: 'Sweden', PL: 'Poland', BE: 'Belgium', IE: 'Ireland' }
const mkt = (m: string) => MARKET_NAME[m] ?? m
const parseEur = (s: string) => Math.max(0, Math.round((parseFloat(s.replace(',', '.')) || 0) * 100))

// ── Inspector (CP.2 actions + CP.4 provenance) ─────────────────────────────
function Inspector({ c, staged, onStage, onClear, onClose }: { c: EnfCampaign; staged: StagedChange | undefined; onStage: (p: Partial<StagedChange>) => void; onClear: () => void; onClose: () => void }) {
  const [budget, setBudget] = useState(staged?.budgetCents != null ? (staged.budgetCents / 100).toFixed(2) : (c.currentDailyCents / 100).toFixed(2))
  const [min, setMin] = useState(staged?.minCents != null ? (staged.minCents / 100).toFixed(2) : '')
  const [max, setMax] = useState(staged?.maxCents != null ? (staged.maxCents / 100).toFixed(2) : '')
  const [history, setHistory] = useState<HistEntry[] | null>(null)
  useEffect(() => { let alive = true; fetch(`${API()}/api/advertising/campaigns/${c.id}/history?limit=8`).then((r) => r.json()).then((j) => { if (alive) setHistory(Array.isArray(j?.entries) ? j.entries : []) }).catch(() => { if (alive) setHistory([]) }); return () => { alive = false } }, [c.id])

  const effSuppress = staged?.suppress != null ? staged.suppress : c.currentlySuppressed
  const stageBudget = (v: string) => { setBudget(v); onStage({ budgetCents: v.trim() === '' ? undefined : parseEur(v) }) }
  const stageMin = (v: string) => { setMin(v); onStage({ minCents: v.trim() === '' ? undefined : parseEur(v) }) }
  const stageMax = (v: string) => { setMax(v); onStage({ maxCents: v.trim() === '' ? undefined : parseEur(v) }) }
  const pin = () => { const v = (c.currentDailyCents / 100).toFixed(2); setBudget(v); setMin(v); setMax(v); onStage({ budgetCents: c.currentDailyCents, minCents: c.currentDailyCents, maxCents: c.currentDailyCents }) }
  const toggleSuppress = () => { const next = !effSuppress; onStage({ suppress: next === c.currentlySuppressed ? undefined : next }) }

  return (
    <aside className="cp-insp">
      <div className="cp-insp-h"><b title={c.name}>{c.name}</b><button type="button" className="x" aria-label="Close inspector" onClick={onClose}>×</button></div>
      <div className="cp-insp-kpis">
        <span><i>Current</i>{eur(c.currentDailyCents)}/day</span>
        <span><i>Paced target</i>{c.targetDailyCents != null ? `${eur(c.targetDailyCents)}/day` : '—'}</span>
        <span><i>Status</i>{c.currentlySuppressed ? 'Suppressed' : 'Active'}</span>
      </div>

      <div className="cp-insp-sec">
        <label className="cp-fld"><span>Daily budget</span><span className="cp-eurin"><i>€</i><input inputMode="decimal" value={budget} onChange={(e) => stageBudget(e.target.value)} aria-label="Daily budget" /></span></label>
        <div className="cp-fld2">
          <label className="cp-fld"><span>Min €/day</span><span className="cp-eurin"><i>€</i><input inputMode="decimal" placeholder="—" value={min} onChange={(e) => stageMin(e.target.value)} aria-label="Min daily" /></span></label>
          <label className="cp-fld"><span>Max €/day</span><span className="cp-eurin"><i>€</i><input inputMode="decimal" placeholder="—" value={max} onChange={(e) => stageMax(e.target.value)} aria-label="Max daily" /></span></label>
        </div>
        <div className="cp-insp-actions">
          <button type="button" className="cp-act" onClick={pin}><Lock size={12} /> Pin budget</button>
          <button type="button" className={`cp-act ${effSuppress ? 'on' : ''}`} onClick={toggleSuppress}>{effSuppress ? 'Restore bids' : 'Suppress (bid floor)'}</button>
        </div>
        {staged && <button type="button" className="cp-clear" onClick={() => { onClear(); setBudget((c.currentDailyCents / 100).toFixed(2)); setMin(''); setMax('') }}>Clear staged change</button>}
      </div>

      <div className="cp-insp-sec">
        <div className="cp-sec-h"><HistoryIcon size={12} /> Recent changes</div>
        {history == null ? <div className="cp-prov-load">Loading…</div>
          : history.length === 0 ? <div className="cp-prov-empty">No recorded changes yet.</div>
          : <div className="cp-prov">{history.map((h) => (
              <div className="cp-prov-row" key={h.id}>
                <span className="f">{h.field}</span>
                <span className="v">{h.oldValue ?? '—'} → {h.newValue ?? '—'}</span>
                <span className="m">{h.actor === 'automation' ? 'auto' : 'you'}{h.reason ? ` · ${h.reason}` : ''}</span>
              </div>))}</div>}
      </div>
    </aside>
  )
}

export function ControlPlane({ open, onClose, enforcement, month, initialMarket, onCommitted, toast }: { open: boolean; onClose: () => void; enforcement: EnforcementResult | null; month: string; initialMarket: string; onCommitted: () => void; toast: (m: string) => void }) {
  const [market, setMarket] = useState(initialMarket)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [scenario, setScenario] = useState<Record<string, StagedChange>>({})
  const [committing, setCommitting] = useState(false)
  useEffect(() => { if (open) { setMarket(initialMarket); setSelectedId(null) } }, [open, initialMarket])

  const plan = useMemo(() => enforcement?.plans.find((p) => p.marketplace === market) ?? enforcement?.plans[0] ?? null, [enforcement, market])
  const selected = useMemo(() => plan?.campaigns.find((c) => c.id === selectedId) ?? null, [plan, selectedId])
  const allCamps = useMemo(() => { const m = new Map<string, EnfCampaign>(); for (const p of enforcement?.plans ?? []) for (const c of p.campaigns) m.set(c.id, c); return m }, [enforcement])

  const stageCount = Object.keys(scenario).length
  const projectedDelta = useMemo(() => { let d = 0; for (const [id, s] of Object.entries(scenario)) { if (s.budgetCents != null) { const c = allCamps.get(id); if (c) d += s.budgetCents - c.currentDailyCents } } return d }, [scenario, allCamps])
  const suppressCount = Object.values(scenario).filter((s) => s.suppress === true).length
  const stagedInMarket = (p: EnfPlan) => p.campaigns.filter((c) => scenario[c.id]).length

  const setStage = (id: string, patch: Partial<StagedChange>) => setScenario((prev) => {
    const merged: Record<string, unknown> = { ...prev[id], ...patch }
    for (const k of Object.keys(merged)) if (merged[k] === undefined) delete merged[k]
    const next = { ...prev }
    if (Object.keys(merged).length === 0) delete next[id]; else next[id] = merged as StagedChange
    return next
  })
  const clearStage = (id: string) => setScenario((prev) => { const n = { ...prev }; delete n[id]; return n })

  const commit = async () => {
    if (stageCount === 0) return
    setCommitting(true)
    const changes: Array<Record<string, unknown>> = []
    for (const [id, s] of Object.entries(scenario)) {
      const mp = [...(enforcement?.plans ?? [])].find((p) => p.campaigns.some((c) => c.id === id))?.marketplace
      if (s.budgetCents != null) changes.push({ campaignId: id, kind: 'budget', budgetCents: s.budgetCents })
      if (s.minCents != null || s.maxCents != null) changes.push({ campaignId: id, marketplace: mp, kind: 'limit', minCents: s.minCents ?? null, maxCents: s.maxCents ?? null })
      if (s.suppress === true) changes.push({ campaignId: id, kind: 'suppress' })
      if (s.suppress === false) changes.push({ campaignId: id, kind: 'restore' })
    }
    try {
      const r = await fetch(`${API()}/api/advertising/budget-manager/scenario/commit`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ month, changes }) }).then((x) => x.json())
      if (r?.ok) { toast(`Committed ${r.applied} change${r.applied === 1 ? '' : 's'} · undo within 5 min`); setScenario({}); setSelectedId(null); onCommitted() }
      else { toast(`Committed ${r?.applied ?? 0}, ${r?.failed ?? 0} failed`); onCommitted() }
    } catch { toast('Commit failed') } finally { setCommitting(false) }
  }

  const tryClose = () => { if (stageCount > 0 && !window.confirm(`Discard ${stageCount} staged change${stageCount === 1 ? '' : 's'}?`)) return; setScenario({}); onClose() }

  if (!open) return null
  return (
    <Modal open onClose={tryClose} size="xl" title="Budget Control Plane" subtitle="Stage budget, limit and suppression changes on the canvas, review, then commit — gated, audited, reversible."
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
                <button type="button" key={p.marketplace} className={`cp-tab ${market === p.marketplace ? 'on' : ''}`} onClick={() => { setMarket(p.marketplace); setSelectedId(null) }}>{FLAG[p.marketplace] ?? '🌐'} {mkt(p.marketplace)}{stagedInMarket(p) > 0 ? <em className="dot"> ●</em> : null}</button>
              ))}
              <span className="grow" />
              <span className="cp-hint">Click a campaign to inspect &amp; stage changes</span>
            </div>
            {plan && <AllocationCanvas plan={plan} selectedId={selectedId} onSelect={setSelectedId} staged={scenario} />}
          </div>
          {selected && plan && <Inspector key={selected.id} c={selected} staged={scenario[selected.id]} onStage={(p) => setStage(selected.id, p)} onClear={() => clearStage(selected.id)} onClose={() => setSelectedId(null)} />}
        </div>
      )}
    </Modal>
  )
}
