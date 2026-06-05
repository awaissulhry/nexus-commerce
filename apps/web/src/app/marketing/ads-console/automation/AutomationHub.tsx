'use client'

/**
 * Ads Console — Automation hub. Tabs: Library (distinct, each-configurable
 * automations) · Playbooks · Active rules (with bulk actions) · Dayparting ·
 * Recommendations · Competitive · Retail · Budgets · Engine & autonomy ·
 * Guardrails · Health. Every automation is one distinct concept, configured per
 * use (Configurator) or quick-added with defaults; bulk-add from the library and
 * bulk enable/pause/dry-run/delete in Active rules. Reuses the audited backend;
 * everything is created disabled + dry-run.
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import { useSearchParams, useRouter } from 'next/navigation'
import { Search, Zap, FlaskConical, Trash2, TrendingUp, ShieldAlert, RefreshCw, Play, Pause, Sparkles, Copy, ChevronDown, AlertTriangle } from 'lucide-react'
import { getBackendUrl } from '@/lib/backend-url'
import { checkRuleLogic } from './synthetic-test'
import { fieldDef, actionDef, triggerDef, OPS, fieldSuffix, condFromRaw, type FieldUnit } from './vocab'
import { AUTOMATIONS, AUTOMATION_COUNT, buildRule, type AutomationDef } from './automations'
import { Configurator } from './Configurator'
import { PLAYBOOKS, playbookAutomations } from './playbooks'
import { cleanName } from './_icons'
import { AnomalyTab } from './AnomalyTab'
import { HarvestTab } from './HarvestTab'
import { NegativeMiningTab } from './NegativeMiningTab'
import { AnalyticsTab } from './AnalyticsTab'
import { BuilderTab } from './BuilderTab'
import { AutomationHome } from './AutomationHome'
import { LibraryTab } from './LibraryTab'
import { EfficiencyTab } from './EfficiencyTab'
import { RankControlTab } from './RankControlTab'
import { campaignHref } from './useCampaignMap'
import { type CustomPlaybook } from './customPlaybooks'
import { DaypartingTab } from './DaypartingTab'
import { HealthTab } from './HealthTab'
import { SovTab } from './SovTab'
import { RetailTab } from './RetailTab'
import { GuardrailsTab } from './GuardrailsTab'
import { BudgetPacingTab } from './BudgetPacingTab'

interface Rule { id: string; name: string; description?: string; trigger: string; conditions: unknown; actions: unknown; enabled: boolean; dryRun: boolean; evaluationCount: number; matchCount: number; executionCount: number; lastExecutedAt?: string | null; domain: string; maxExecutionsPerDay?: number | null; maxDailyAdSpendCentsEur?: number | null; maxValueCentsEur?: number | null; scopeMarketplace?: string | null }
interface State { autonomy?: string; halted?: boolean; haltReason?: string | null; effectivelyStopped?: boolean; lastCheckedAt?: string | null }
interface Rec { id: string; category: string; severity: string; title: string; detail: string; estImpactCents?: number; apply?: { kind: string; payload: unknown } }
interface RecResp { generatedAt?: string; counts?: Record<string, number>; potentialMonthlyImpactCents?: number; recommendations?: Rec[] }

const eur = (c: number | null | undefined) => (c == null ? '—' : new Intl.NumberFormat('en-IE', { style: 'currency', currency: 'EUR', maximumFractionDigits: 0 }).format(c / 100))
const trgLabel = (t: string) => (t === 'SCHEDULE' ? 'SCHEDULED' : t.replace(/_/g, ' '))
const relTime = (iso: string) => { const s = Math.floor((Date.now() - new Date(iso).getTime()) / 1000); if (s < 60) return 'just now'; const m = Math.floor(s / 60); if (m < 60) return `${m}m ago`; const h = Math.floor(m / 60); if (h < 24) return `${h}h ago`; const d = Math.floor(h / 24); return d < 30 ? `${d}d ago` : `${Math.floor(d / 30)}mo ago` }
const post = (path: string, body?: unknown) => fetch(`${getBackendUrl()}/api/advertising/${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined })
// RC6.4 — render a stored (engine-raw) rule back into plain English for the drill-through panel.
const opSym = (op: string) => OPS.find((o) => o.v === op)?.l ?? op
const condLeaf = (c: { field?: string; op?: string; value?: unknown }) => { const fd = fieldDef(c.field ?? ''); const u: FieldUnit = fd?.unit ?? 'num'; if (c.op === 'exists') return `${fd?.label ?? c.field} exists`; const val = typeof c.value === 'number' ? condFromRaw(u, c.value) : String(c.value ?? ''); return `${fd?.label ?? c.field} ${opSym(c.op ?? '')} ${val}${fieldSuffix(u)}` }
function humanConditions(p: unknown): string {
  if (p == null) return 'always (no conditions)'
  if (Array.isArray(p)) return p.length ? p.map(condLeaf).join(' AND ') : 'always (no conditions)'
  const n = p as { kind?: string; children?: unknown[]; child?: unknown; field?: string }
  if (n.kind === 'or') return (n.children ?? []).map(humanConditions).join('  OR  ')
  if (n.kind === 'and') return (n.children ?? []).map(humanConditions).join(' AND ')
  if (n.kind === 'not') return `NOT (${humanConditions(n.child)})`
  if (n.kind === 'leaf' || n.field) return condLeaf(n as { field?: string; op?: string; value?: unknown })
  return '—'
}
const humanActions = (actions: unknown): string => (Array.isArray(actions) ? actions.map((a) => actionDef((a as { type?: string })?.type ?? '')?.label ?? (a as { type?: string })?.type ?? '?').join(', ') : '—')
const patch = (id: string, body: Record<string, unknown>) => fetch(`${getBackendUrl()}/api/advertising/automation-rules/${id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })

export function AutomationHub({ initialRules, initialState }: { initialRules: Rule[]; initialState: State | null }) {
  const searchParams = useSearchParams()
  const router = useRouter()
  const tab = searchParams.get('tab') ?? 'home'
  const setTab = (k: string) => router.replace(`/marketing/ads-console/automation?tab=${k}`, { scroll: false })
  const [rules, setRules] = useState<Rule[]>(initialRules.filter((r) => r.domain === 'advertising'))
  const [state, setState] = useState<State | null>(initialState)
  const [ruleQ, setRuleQ] = useState('')
  const [ruleFilter, setRuleFilter] = useState<'all' | 'live' | 'dry' | 'off'>('all')
  const [busy, setBusy] = useState<string | null>(null)
  const [recs, setRecs] = useState<RecResp | null>(null)
  const [engineMsg, setEngineMsg] = useState<Record<string, string>>({})
  const [configuring, setConfiguring] = useState<AutomationDef | null>(null)
  const [selRules, setSelRules] = useState<Set<string>>(new Set()) // active-rules multi-select
  const [selRecs, setSelRecs] = useState<Set<string>>(new Set())   // recommendations multi-select
  const [groupBy, setGroupBy] = useState<'none' | 'trigger' | 'status'>('none') // RC6.4
  const [expanded, setExpanded] = useState<Set<string>>(new Set())              // RC6.4 drill-through

  const refetchRules = useCallback(async () => {
    const d = await fetch(`${getBackendUrl()}/api/advertising/automation-rules`, { cache: 'no-store' }).then((r) => r.json()).catch(() => ({ items: [] }))
    setRules((d.items ?? []).filter((r: Rule) => r.domain === 'advertising'))
  }, [])
  const refetchState = useCallback(async () => {
    const d = await fetch(`${getBackendUrl()}/api/advertising/automation/state`, { cache: 'no-store' }).then((r) => r.json()).catch(() => null)
    setState(d)
  }, [])
  useEffect(() => { void fetch(`${getBackendUrl()}/api/advertising/recommendations?limit=80`, { cache: 'no-store' }).then((r) => r.json()).then(setRecs).catch(() => {}) }, [])

  const ruleNames = useMemo(() => new Set(rules.map((r) => r.name)), [rules])
  const liveCount = rules.filter((r) => r.enabled && !r.dryRun).length
  const activeCount = rules.filter((r) => r.enabled).length

  const createFromDef = (def: AutomationDef) => { const b = buildRule(def); return post('automation-rules', { name: def.name, description: def.desc, trigger: def.trigger, conditions: b.conditions, actions: b.actions, maxExecutionsPerDay: b.maxExecutionsPerDay, maxDailyAdSpendCentsEur: b.maxDailyAdSpendCentsEur ?? null }) }
  const addAutomation = async (def: AutomationDef) => { setBusy(def.id); try { await createFromDef(def); await refetchRules() } finally { setBusy(null) } }
  const addMany = async (defs: AutomationDef[]) => { setBusy('bulk'); try { for (const def of defs) { if (!ruleNames.has(def.name)) await createFromDef(def) } await refetchRules() } finally { setBusy(null) } }
  const enablePlaybook = async (pid: string) => { const pb = PLAYBOOKS.find((p) => p.id === pid); if (!pb) return; setBusy(`pb:${pid}`); try { for (const def of playbookAutomations(pb)) { if (!ruleNames.has(def.name)) await createFromDef(def) } await refetchRules() } finally { setBusy(null) } }
  const activateCustom = async (pb: CustomPlaybook) => { setBusy(`cpb:${pb.id}`); try { for (const id of pb.automationIds) { const def = AUTOMATIONS.find((a) => a.id === id); if (def && !ruleNames.has(def.name)) await createFromDef(def) } await refetchRules() } finally { setBusy(null) } }

  const toggleEnabled = async (r: Rule) => { setBusy(r.id); try { await patch(r.id, { enabled: !r.enabled }); await refetchRules() } finally { setBusy(null) } }
  const toggleLive = async (r: Rule) => { if (r.dryRun && typeof window !== 'undefined' && !window.confirm(`Run "${r.name}" LIVE? It will make real changes to your campaigns (within your guardrails + per-campaign allowlist).`)) return; setBusy(r.id); try { await patch(r.id, { dryRun: !r.dryRun }); await refetchRules() } finally { setBusy(null) } }
  const testRule = async (r: Rule) => { setBusy(r.id); setExpanded((s) => new Set(s).add(r.id)); try { const { matched } = await checkRuleLogic(r.id, r.conditions); setEngineMsg((m) => ({ ...m, [r.id]: matched === true ? 'Logic ✓ — fires on a matching entity' : matched === false ? 'No match on a sample entity — review conditions' : 'Logic check unavailable' })) } finally { setBusy(null) } }
  const cloneRule = async (r: Rule) => { setBusy(r.id); try { await post('automation-rules', { name: `${cleanName(r.name)} (copy)`, description: r.description ?? undefined, trigger: r.trigger, conditions: r.conditions, actions: r.actions, maxExecutionsPerDay: r.maxExecutionsPerDay ?? 20, maxDailyAdSpendCentsEur: r.maxDailyAdSpendCentsEur ?? null, maxValueCentsEur: r.maxValueCentsEur ?? null, scopeMarketplace: r.scopeMarketplace ?? null }); await refetchRules() } finally { setBusy(null) } }
  const deleteRule = async (r: Rule) => { if (typeof window !== 'undefined' && !window.confirm(`Delete "${r.name}"?`)) return; setBusy(r.id); try { await fetch(`${getBackendUrl()}/api/advertising/automation-rules/${r.id}`, { method: 'DELETE' }); await refetchRules() } finally { setBusy(null) } }
  const bulkRules = async (action: 'enable' | 'pause' | 'dry' | 'live' | 'delete') => {
    const ids = [...selRules]; if (!ids.length) return
    if (action === 'delete' && typeof window !== 'undefined' && !window.confirm(`Delete ${ids.length} rule(s)?`)) return
    if (action === 'live' && typeof window !== 'undefined' && !window.confirm(`Set ${ids.length} rule(s) LIVE? Real changes will be made.`)) return
    setBusy('bulkrules')
    try {
      for (const id of ids) {
        if (action === 'delete') await fetch(`${getBackendUrl()}/api/advertising/automation-rules/${id}`, { method: 'DELETE' })
        else await patch(id, action === 'enable' ? { enabled: true } : action === 'pause' ? { enabled: false } : action === 'dry' ? { dryRun: true } : { dryRun: false })
      }
      setSelRules(new Set()); await refetchRules()
    } finally { setBusy(null) }
  }
  const applyRec = async (rec: Rec) => { setBusy(rec.id); try { await post('recommendations/apply', { id: rec.id, kind: rec.apply?.kind, payload: rec.apply?.payload }); await fetch(`${getBackendUrl()}/api/advertising/recommendations?limit=80`, { cache: 'no-store' }).then((r) => r.json()).then(setRecs) } finally { setBusy(null) } }
  const applyRecs = async (list: Rec[]) => { if (!list.length) return; setBusy('recs-bulk'); try { let ok = 0, failed = 0; for (const rec of list) { try { const r = await post('recommendations/apply', { id: rec.id, kind: rec.apply?.kind, payload: rec.apply?.payload }); if (r.ok) ok++; else failed++ } catch { failed++ } } await fetch(`${getBackendUrl()}/api/advertising/recommendations?limit=80`, { cache: 'no-store' }).then((r) => r.json()).then(setRecs); setSelRecs(new Set()); setEngineMsg((m) => ({ ...m, 'recs-bulk': failed ? `Applied ${ok} · ${failed} could not be applied` : `Applied ${ok}` })) } finally { setBusy(null) } }
  const toggleRec = (id: string) => setSelRecs((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n })
  const recCampaignId = (rec: Rec): string | null => { const p = rec.apply?.payload as { campaignIds?: string[] } | undefined; return p?.campaignIds?.[0] ?? null }
  const runEngine = async (key: string, path: string, label: string) => { if (typeof window !== 'undefined' && !window.confirm(`Run ${label} now? It honours each rule's dry-run setting.`)) return; setBusy(key); setEngineMsg((m) => ({ ...m, [key]: 'Running…' })); try { const res = await post(path, {}).then((x) => x.json()).catch(() => null); setEngineMsg((m) => ({ ...m, [key]: res ? (res.message ?? `Done · ${res.applied ?? res.count ?? res.changed ?? 0} action(s)`) : 'Done' })) } finally { setBusy(null) } }
  const setHalt = async (halt: boolean) => { setBusy('halt'); try { await post(halt ? 'automation/halt' : 'automation/resume', halt ? { reason: 'Manual halt from console' } : undefined); await refetchState() } finally { setBusy(null) } }

  const toggleSelRule = (id: string) => setSelRules((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n })
  const shownRules = useMemo(() => { const ql = ruleQ.trim().toLowerCase(); return rules.filter((r) => (ruleFilter === 'all' || (ruleFilter === 'live' && r.enabled && !r.dryRun) || (ruleFilter === 'dry' && r.enabled && r.dryRun) || (ruleFilter === 'off' && !r.enabled)) && (!ql || cleanName(r.name).toLowerCase().includes(ql) || (r.description ?? '').toLowerCase().includes(ql) || r.trigger.toLowerCase().includes(ql))) }, [rules, ruleQ, ruleFilter])
  const triggerStats = useMemo(() => { const m: Record<string, { count: number; matches: number; runs: number }> = {}; for (const r of rules) { (m[r.trigger] ??= { count: 0, matches: 0, runs: 0 }); m[r.trigger].count++; m[r.trigger].matches += r.matchCount ?? 0; m[r.trigger].runs += r.executionCount ?? 0 } return Object.entries(m).sort((a, b) => b[1].runs - a[1].runs || b[1].count - a[1].count) }, [rules])
  const allRulesSel = shownRules.length > 0 && shownRules.every((r) => selRules.has(r.id))
  const toggleExpand = (id: string) => setExpanded((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n })
  // RC6.4 — client-side conflict detection across ENABLED rules sharing a trigger:
  // exact duplicates, and opposing actions (raise vs lower, pause vs resume/enable).
  const conflicts = useMemo(() => {
    const map = new Map<string, string[]>()
    const add = (id: string, reason: string) => { const a = map.get(id) ?? []; if (!a.includes(reason)) a.push(reason); map.set(id, a) }
    const OPP: Array<[string, string]> = [['bid_up', 'bid_down'], ['pause_campaign', 'resume_campaign'], ['pause_campaign', 'enable_campaign'], ['pause_all_campaigns', 'resume_campaign'], ['pause_all_campaigns', 'enable_campaign'], ['pause_ad_group', 'resume_campaign'], ['lower_bid_to_floor', 'bid_up'], ['lower_bid_to_floor', 'raise_bids_for_rank_defense']]
    const actTypes = (r: Rule) => new Set((Array.isArray(r.actions) ? r.actions : []).map((a) => (a as { type?: string })?.type).filter(Boolean) as string[])
    const sameScope = (a: Rule, b: Rule) => !a.scopeMarketplace || !b.scopeMarketplace || a.scopeMarketplace === b.scopeMarketplace
    const en = rules.filter((r) => r.enabled)
    for (let i = 0; i < en.length; i++) for (let j = i + 1; j < en.length; j++) {
      const a = en[i], b = en[j]
      if (a.trigger !== b.trigger || !sameScope(a, b)) continue
      if (JSON.stringify(a.actions) === JSON.stringify(b.actions) && JSON.stringify(a.conditions) === JSON.stringify(b.conditions)) { add(a.id, `Duplicate of “${cleanName(b.name)}”`); add(b.id, `Duplicate of “${cleanName(a.name)}”`); continue }
      const sa = actTypes(a), sb = actTypes(b)
      for (const [x, y] of OPP) if ((sa.has(x) && sb.has(y)) || (sa.has(y) && sb.has(x))) { add(a.id, `May fight “${cleanName(b.name)}” on ${trgLabel(a.trigger)}`); add(b.id, `May fight “${cleanName(a.name)}” on ${trgLabel(a.trigger)}`) }
    }
    return map
  }, [rules])
  const grouped = useMemo<Array<[string, Rule[]]>>(() => {
    if (groupBy === 'none') return [['', shownRules]]
    const m = new Map<string, Rule[]>()
    for (const r of shownRules) { const k = groupBy === 'trigger' ? trgLabel(r.trigger) : (!r.enabled ? 'Off' : r.dryRun ? 'Dry-run' : 'Live'); const a = m.get(k) ?? []; a.push(r); m.set(k, a) }
    return [...m.entries()].sort((a, b) => b[1].length - a[1].length)
  }, [shownRules, groupBy])

  return (
    <div className="az-wrap">
      <div className="az-listhead"><span className="title"><Zap size={18} style={{ marginRight: 6, color: 'var(--orange)' }} />Automation</span><span style={{ flex: 1 }} /></div>

      {tab !== 'home' && (
      <div className="az-hero">
        <div className="az-stat"><div className="k">Automations</div><div className="v">{AUTOMATION_COUNT}</div><div className="s">distinct · each fully configurable</div></div>
        <div className="az-stat"><div className="k">Active rules</div><div className="v">{activeCount}</div><div className="s">{liveCount} live · {activeCount - liveCount} dry-run</div></div>
        <div className="az-stat"><div className="k">Opportunity / mo</div><div className="v" style={{ color: 'var(--green)' }}>{recs ? eur(recs.potentialMonthlyImpactCents) : '…'}</div><div className="s">{recs?.recommendations?.length ?? 0} recommendations</div></div>
        <div className="az-stat"><div className="k">Engine</div><div className="v" style={{ color: state?.effectivelyStopped ? '#cc1100' : 'var(--green)' }}>{state?.effectivelyStopped ? 'Halted' : state?.autonomy ?? 'AUTO'}</div><div className="s">{state?.halted ? 'kill-switch on' : 'running'}</div></div>
      </div>
      )}

      {tab === 'home' && <AutomationHome rules={rules} recs={recs?.recommendations ?? []} state={state} onTab={setTab} />}

      {(tab === 'library' || tab === 'playbooks') && (
        <LibraryTab
          ruleNames={ruleNames}
          busy={busy}
          onAdd={addAutomation}
          onAddMany={addMany}
          onEnablePlaybook={enablePlaybook}
          onActivateCustom={activateCustom}
          onConfigure={setConfiguring}
          onBuildCustom={() => setTab('builder')}
          onGoActive={() => setTab('active')}
        />
      )}

      {tab === 'active' && <div style={{ paddingTop: 4 }}>
        {rules.length > 0 && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10, flexWrap: 'wrap' }}>
            <div className="az-search" style={{ minWidth: 220, padding: '6px 10px' }}><Search size={14} /><input placeholder="Find a rule" value={ruleQ} onChange={(e) => setRuleQ(e.target.value)} /></div>
            {(['all', 'live', 'dry', 'off'] as const).map((f) => <button key={f} className={`az-chip quick ${ruleFilter === f ? 'on' : ''}`} onClick={() => setRuleFilter(f)}>{f === 'all' ? `All ${rules.length}` : f === 'live' ? `Live ${liveCount}` : f === 'dry' ? `Dry-run ${activeCount - liveCount}` : `Off ${rules.length - activeCount}`}</button>)}
            <span style={{ flex: 1 }} />
            <span className="az-rowstat" style={{ fontSize: 12, color: 'var(--ink2)' }}>Group
              <select value={groupBy} onChange={(e) => setGroupBy(e.target.value as 'none' | 'trigger' | 'status')} style={{ marginLeft: 6, border: '1px solid var(--border)', borderRadius: 6, padding: '4px 7px', font: 'inherit', cursor: 'pointer' }}>
                <option value="none">None</option><option value="trigger">Trigger</option><option value="status">Status</option>
              </select>
            </span>
            <label className="az-rowstat" style={{ fontSize: 12.5, cursor: 'pointer' }}><input type="checkbox" className="az-check" checked={allRulesSel} onChange={(e) => setSelRules(e.target.checked ? new Set(shownRules.map((r) => r.id)) : new Set())} style={{ marginRight: 6 }} />Select all</label>
            {selRules.size > 0
              ? <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}><b>{selRules.size} selected</b><button className="az-btn" disabled={busy === 'bulkrules'} onClick={() => void bulkRules('enable')}><Play size={13} />Enable</button><button className="az-btn" disabled={busy === 'bulkrules'} onClick={() => void bulkRules('pause')}><Pause size={13} />Pause</button><button className="az-btn" disabled={busy === 'bulkrules'} onClick={() => void bulkRules('dry')}>Dry-run</button><button className="az-btn" disabled={busy === 'bulkrules'} onClick={() => void bulkRules('live')} style={{ color: '#cc1100', borderColor: '#f4c7c0' }}>Set live</button><button className="az-btn" disabled={busy === 'bulkrules'} onClick={() => void bulkRules('delete')} style={{ color: '#cc1100', borderColor: '#f4c7c0' }}><Trash2 size={13} />Delete</button><button className="az-link" onClick={() => setSelRules(new Set())}>Clear</button></span>
              : <span style={{ color: 'var(--ink2)', fontSize: 12 }}>{activeCount} active · {liveCount} live · select rules for bulk actions</span>}
          </div>
        )}
        {triggerStats.length > 1 && (
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 12 }}>
            {triggerStats.map(([trg, s]) => (
              <button key={trg} onClick={() => setRuleQ(ruleQ === trg ? '' : trg)} title="Filter rules to this trigger" style={{ textAlign: 'left', border: `1px solid ${ruleQ === trg ? 'var(--navy)' : 'var(--divider)'}`, background: ruleQ === trg ? 'var(--bg2)' : '#fff', borderRadius: 8, padding: '7px 11px', cursor: 'pointer', minWidth: 116 }}>
                <div style={{ fontSize: 10, fontWeight: 700, color: 'var(--ink2)', letterSpacing: 0.2 }}>{trgLabel(trg)}</div>
                <div style={{ fontSize: 12.5, fontWeight: 600, marginTop: 2 }}>{s.count} rule{s.count > 1 ? 's' : ''} · {s.runs} run{s.runs === 1 ? '' : 's'}</div>
                <div style={{ fontSize: 10.5, color: 'var(--ink2)', marginTop: 1 }}>{s.matches} match{s.matches === 1 ? '' : 'es'}{s.matches > 0 ? ` · ${Math.round((s.runs / s.matches) * 100)}% acted` : ''}</div>
              </button>
            ))}
          </div>
        )}
        {conflicts.size > 0 && (
          <div className="az-conflict-banner"><AlertTriangle size={15} /><span><b>{conflicts.size} rule{conflicts.size > 1 ? 's' : ''} may conflict.</b> Enabled rules on the same trigger with opposing or duplicate actions can fight each other — expand a flagged rule to see why.</span></div>
        )}
        {rules.length === 0 && <div className="az-empty" style={{ border: '1px solid var(--divider)', borderRadius: 10 }}>No rules yet — add some from the Library.</div>}
        {rules.length > 0 && shownRules.length === 0 && <div className="az-empty" style={{ border: '1px solid var(--divider)', borderRadius: 10 }}>No rules match this filter.</div>}
        {grouped.map(([gname, list]) => (
          <div key={gname || '_all'}>
            {gname && <div className="az-rulegroup">{gname}<span>{list.length}</span></div>}
            {list.map((r) => {
              const conf = conflicts.get(r.id)
              const acted = (r.matchCount ?? 0) > 0 ? Math.round(((r.executionCount ?? 0) / (r.matchCount ?? 1)) * 100) : null
              const isExp = expanded.has(r.id)
              return (
                <div key={r.id} className="az-rwrap">
                  <div className={`az-rule ${selRules.has(r.id) ? 'sel' : ''} ${conf ? 'conf' : ''}`}>
                    <input type="checkbox" className="az-check" checked={selRules.has(r.id)} onChange={() => toggleSelRule(r.id)} aria-label={`Select ${r.name}`} />
                    <button className={`az-toggle ${r.enabled ? 'on' : ''}`} disabled={busy === r.id} onClick={() => void toggleEnabled(r)} aria-label="Enable rule" title={r.enabled ? 'Enabled' : 'Disabled'}><i /></button>
                    <div className="nm"><div className="t">{cleanName(r.name)}{conf && <span className="az-conflict" title={conf.join(' · ')}><AlertTriangle size={11} />conflict</span>}</div><div className="d2">{cleanName(r.description)}</div></div>
                    <span className="trg" style={{ background: 'var(--bg2)', borderRadius: 5, padding: '2px 7px', fontSize: 10, fontWeight: 700, color: 'var(--ink2)' }}>{trgLabel(r.trigger)}</span>
                    <div className="stat" title="Times this rule's conditions matched"><b>{r.matchCount ?? 0}</b>matches</div>
                    <div className="stat" title={r.lastExecutedAt ? `Last run ${new Date(r.lastExecutedAt).toLocaleString()}` : 'Never run'}><b>{r.executionCount ?? 0}</b>{r.lastExecutedAt ? relTime(r.lastExecutedAt) : 'runs'}</div>
                    <div className="stat" title="Acted = runs ÷ matches"><b>{acted == null ? '—' : `${acted}%`}</b>acted</div>
                    <button className={`az-live ${r.dryRun ? 'dry' : 'on'}`} disabled={busy === r.id} onClick={() => void toggleLive(r)} title="Toggle dry-run / live">{r.dryRun ? 'Dry run' : 'LIVE'}</button>
                    <button className="az-btn" disabled={busy === r.id} onClick={() => void testRule(r)} title="Check logic + show details"><FlaskConical size={14} /></button>
                    <button className="az-btn" disabled={busy === r.id} onClick={() => void cloneRule(r)} title="Duplicate this rule"><Copy size={14} /></button>
                    <button className="az-kebab" onClick={() => toggleExpand(r.id)} title="Show details" aria-expanded={isExp}><ChevronDown size={15} style={{ transform: isExp ? 'rotate(180deg)' : undefined, transition: 'transform .12s' }} /></button>
                    <button className="az-kebab" disabled={busy === r.id} onClick={() => void deleteRule(r)} title="Delete" style={{ color: '#cc1100' }}><Trash2 size={15} /></button>
                    {engineMsg[r.id] && <span style={{ color: 'var(--ink2)', fontSize: 11 }}>{engineMsg[r.id]}</span>}
                  </div>
                  {isExp && (
                    <div className="az-rule-detail">
                      <div><b>When</b> {triggerDef(r.trigger)?.label ?? trgLabel(r.trigger)}</div>
                      <div><b>If</b> {humanConditions(r.conditions)}</div>
                      <div><b>Then</b> {humanActions(r.actions)}</div>
                      {conf && <div className="warn"><AlertTriangle size={12} /> {conf.join(' · ')}</div>}
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        ))}
      </div>}

      {tab === 'recs' && <div style={{ paddingTop: 4 }}>
        {!recs && <div className="az-empty">Loading recommendations…</div>}
        {recs && (recs.recommendations ?? []).length === 0 && <div className="az-empty" style={{ border: '1px solid var(--divider)', borderRadius: 10 }}>No recommendations right now — you’re dialled in.</div>}
        {recs && (recs.recommendations ?? []).length > 0 && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10, flexWrap: 'wrap' }}>
            <span style={{ fontSize: 12.5, color: 'var(--ink2)' }}><b style={{ color: 'var(--green)' }}>{eur(recs.potentialMonthlyImpactCents)}</b>/mo opportunity · {(recs.recommendations ?? []).length} recommendations</span>
            {engineMsg['recs-bulk'] && <span style={{ fontSize: 11.5, color: 'var(--ink2)' }}>{engineMsg['recs-bulk']}</span>}
            <span style={{ flex: 1 }} />
            {selRecs.size > 0 && <button className="az-btn" disabled={busy === 'recs-bulk'} onClick={() => void applyRecs((recs.recommendations ?? []).filter((r) => selRecs.has(r.id) && r.apply))}>{busy === 'recs-bulk' ? 'Applying…' : `Apply ${selRecs.size} selected`}</button>}
            <button className="az-btn dark" disabled={busy === 'recs-bulk'} onClick={() => void applyRecs((recs.recommendations ?? []).filter((r) => r.apply))}>{busy === 'recs-bulk' ? 'Applying…' : 'Apply all'}</button>
          </div>
        )}
        {recs && (recs.recommendations ?? []).map((rec) => { const cid = recCampaignId(rec); return (
          <div key={rec.id} className="az-rec">
            {rec.apply && <input type="checkbox" className="az-check" checked={selRecs.has(rec.id)} onChange={() => toggleRec(rec.id)} style={{ alignSelf: 'center' }} aria-label="Select recommendation" />}
            <span className={`sev ${rec.severity}`} />
            <div className="body"><div className="t">{cleanName(rec.title)}{rec.estImpactCents ? <span style={{ color: 'var(--green)', fontWeight: 700, marginLeft: 8 }}>{eur(rec.estImpactCents)}/mo</span> : null}</div><div className="d">{cleanName(rec.detail)}{cid ? <> · <a className="cn" href={campaignHref(cid)} target="_blank" rel="noopener noreferrer">view campaign</a></> : null}</div></div>
            <span className="trg" style={{ background: 'var(--bg2)', borderRadius: 5, padding: '2px 8px', fontSize: 10.5, fontWeight: 700, color: 'var(--ink2)', alignSelf: 'center' }}>{rec.category}</span>
            {rec.apply && <button className="az-btn dark" disabled={busy === rec.id} onClick={() => void applyRec(rec)} style={{ alignSelf: 'center' }}>{busy === rec.id ? 'Applying…' : 'Apply'}</button>}
          </div>
        ) })}
      </div>}

      {(tab === 'engine' || tab === 'safety') && <div style={{ paddingTop: 4 }}>
        <div className="az-eng-card" style={{ marginBottom: 16, borderColor: state?.effectivelyStopped ? '#f4c7c0' : undefined }}>
          <h4><ShieldAlert size={15} style={{ marginRight: 6, verticalAlign: 'text-bottom' }} />Autonomy &amp; kill-switch</h4>
          <p>Engine state: <b style={{ color: state?.effectivelyStopped ? '#cc1100' : 'var(--green)' }}>{state?.effectivelyStopped ? 'HALTED' : state?.autonomy ?? 'AUTO'}</b>{state?.haltReason ? ` — ${state.haltReason}` : ''}. The kill-switch instantly stops every automation from acting.</p>
          <div style={{ display: 'flex', gap: 10 }}>
            {state?.halted
              ? <button className="az-btn dark" disabled={busy === 'halt'} onClick={() => void setHalt(false)}><Play size={14} />Resume engine</button>
              : <button className="az-btn" disabled={busy === 'halt'} onClick={() => void setHalt(true)} style={{ color: '#cc1100', borderColor: '#f4c7c0' }}><Pause size={14} />Halt all automation</button>}
            <button className="az-iconbtn" onClick={() => void refetchState()} title="Refresh"><RefreshCw size={15} /></button>
          </div>
        </div>
        <div className="az-engine">
          {[
            { key: 'bid', path: 'automation/auto-bid/run', label: 'Bid optimisation', icon: <TrendingUp size={15} />, desc: 'Tune every keyword bid toward its profit-ACOS target now.' },
            { key: 'harvest', path: 'automation/auto-harvest/run', label: 'Harvest & negate', icon: <Sparkles size={15} />, desc: 'Promote converting search terms + negate wasted ones now.' },
            { key: 'guard', path: 'automation/guard/run', label: 'Retail guard', icon: <ShieldAlert size={15} />, desc: 'Pause ads on out-of-stock / lost-Buy-Box products now.' },
            { key: 'daypart', path: 'dayparting/run-now', label: 'Dayparting', icon: <Zap size={15} />, desc: 'Apply hour-of-day bid modifiers from your dayparting plan.' },
          ].map((e) => (
            <div key={e.key} className="az-eng-card">
              <h4>{e.icon} <span style={{ marginLeft: 4 }}>{e.label}</span></h4>
              <p>{e.desc}</p>
              <button className="az-btn dark" disabled={busy === e.key} onClick={() => void runEngine(e.key, e.path, e.label)}>{busy === e.key ? 'Running…' : 'Run now'}</button>
              {engineMsg[e.key] && <div style={{ color: 'var(--ink2)', fontSize: 11.5, marginTop: 8 }}>{engineMsg[e.key]}</div>}
            </div>
          ))}
        </div>
        <div style={{ color: 'var(--ink2)', fontSize: 12, padding: '14px 2px' }}>Manual runs honour each rule’s dry-run setting — a dry-run rule only previews. Set targets &amp; thresholds per rule in the Active rules tab.</div>
      </div>}

      {tab === 'dayparting' && <DaypartingTab />}
      {tab === 'competitive' && <SovTab />}
      {tab === 'retail' && <RetailTab />}
      {tab === 'budget' && <BudgetPacingTab />}
      {tab === 'guardrails' && <GuardrailsTab />}
      {tab === 'health' && <HealthTab />}
      {(tab === 'analytics' || tab === 'insights') && <AnalyticsTab />}
      {tab === 'efficiency' && <EfficiencyTab />}
      {(tab === 'composer' || tab === 'builder') && <BuilderTab onSaved={() => { void refetchRules() }} onGoActive={() => setTab('active')} />}
      {tab === 'rank' && <RankControlTab onSaved={() => { void refetchRules() }} />}
      {tab === 'anomaly' && <AnomalyTab />}
      {tab === 'harvest' && <HarvestTab />}
      {tab === 'negatives' && <NegativeMiningTab />}

      {configuring && <Configurator def={configuring} onClose={() => setConfiguring(null)} onSaved={() => { void refetchRules() }} />}
    </div>
  )
}
