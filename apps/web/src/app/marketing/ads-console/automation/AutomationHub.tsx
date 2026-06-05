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
import { Search, Zap, FlaskConical, Trash2, TrendingUp, ShieldAlert, RefreshCw, Play, Pause, Sparkles } from 'lucide-react'
import { getBackendUrl } from '@/lib/backend-url'
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

interface Rule { id: string; name: string; description?: string; trigger: string; conditions: unknown[]; actions: unknown[]; enabled: boolean; dryRun: boolean; evaluationCount: number; matchCount: number; executionCount: number; lastExecutedAt?: string | null; domain: string }
interface State { autonomy?: string; halted?: boolean; haltReason?: string | null; effectivelyStopped?: boolean; lastCheckedAt?: string | null }
interface Rec { id: string; category: string; severity: string; title: string; detail: string; estImpactCents?: number; apply?: { kind: string; payload: unknown } }
interface RecResp { generatedAt?: string; counts?: Record<string, number>; potentialMonthlyImpactCents?: number; recommendations?: Rec[] }

const eur = (c: number | null | undefined) => (c == null ? '—' : new Intl.NumberFormat('en-IE', { style: 'currency', currency: 'EUR', maximumFractionDigits: 0 }).format(c / 100))
const trgLabel = (t: string) => (t === 'SCHEDULE' ? 'SCHEDULED' : t.replace(/_/g, ' '))
const relTime = (iso: string) => { const s = Math.floor((Date.now() - new Date(iso).getTime()) / 1000); if (s < 60) return 'just now'; const m = Math.floor(s / 60); if (m < 60) return `${m}m ago`; const h = Math.floor(m / 60); if (h < 24) return `${h}h ago`; const d = Math.floor(h / 24); return d < 30 ? `${d}d ago` : `${Math.floor(d / 30)}mo ago` }
const post = (path: string, body?: unknown) => fetch(`${getBackendUrl()}/api/advertising/${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined })
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
  const testRule = async (r: Rule) => { setBusy(r.id); try { const res = await post(`automation-rules/${r.id}/test`).then((x) => x.json()).catch(() => null); setEngineMsg((m) => ({ ...m, [r.id]: res ? `Tested · ${res.matched ?? res.matches ?? 0} match(es)` : 'Tested' })) } finally { setBusy(null) } }
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
        {rules.length === 0 && <div className="az-empty" style={{ border: '1px solid var(--divider)', borderRadius: 10 }}>No rules yet — add some from the Library.</div>}
        {rules.length > 0 && shownRules.length === 0 && <div className="az-empty" style={{ border: '1px solid var(--divider)', borderRadius: 10 }}>No rules match this filter.</div>}
        {shownRules.map((r) => (
          <div key={r.id} className={`az-rule ${selRules.has(r.id) ? 'sel' : ''}`}>
            <input type="checkbox" className="az-check" checked={selRules.has(r.id)} onChange={() => toggleSelRule(r.id)} aria-label={`Select ${r.name}`} />
            <button className={`az-toggle ${r.enabled ? 'on' : ''}`} disabled={busy === r.id} onClick={() => void toggleEnabled(r)} aria-label="Enable rule" title={r.enabled ? 'Enabled' : 'Disabled'}><i /></button>
            <div className="nm"><div className="t">{cleanName(r.name)}</div><div className="d2">{cleanName(r.description)}</div></div>
            <span className="trg" style={{ background: 'var(--bg2)', borderRadius: 5, padding: '2px 7px', fontSize: 10, fontWeight: 700, color: 'var(--ink2)' }}>{trgLabel(r.trigger)}</span>
            <div className="stat" title="Times this rule's conditions matched"><b>{r.matchCount ?? 0}</b>matches</div>
            <div className="stat" title={r.lastExecutedAt ? `Last run ${new Date(r.lastExecutedAt).toLocaleString()}` : 'Never run'}><b>{r.executionCount ?? 0}</b>{r.lastExecutedAt ? relTime(r.lastExecutedAt) : 'runs'}</div>
            <button className={`az-live ${r.dryRun ? 'dry' : 'on'}`} disabled={busy === r.id} onClick={() => void toggleLive(r)} title="Toggle dry-run / live">{r.dryRun ? 'Dry run' : 'LIVE'}</button>
            <button className="az-btn" disabled={busy === r.id} onClick={() => void testRule(r)} title="Test against current data"><FlaskConical size={14} /></button>
            <button className="az-kebab" disabled={busy === r.id} onClick={() => void deleteRule(r)} title="Delete" style={{ color: '#cc1100' }}><Trash2 size={15} /></button>
            {engineMsg[r.id] && <span style={{ color: 'var(--ink2)', fontSize: 11 }}>{engineMsg[r.id]}</span>}
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
