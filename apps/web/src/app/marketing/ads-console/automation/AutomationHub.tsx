'use client'

/**
 * Ads Console — Automation hub. Four tabs:
 *  • Library — the big catalogue (catalog.ts); one-click Enable creates a real
 *    rule (POST /automation-rules, seeded enabled:false + dryRun:true).
 *  • Active rules — GET /automation-rules; per-rule Active toggle (PATCH enabled),
 *    Dry-run↔Live (PATCH dryRun, confirm on going live), Test, Delete, counters.
 *  • Recommendations — GET /recommendations (live impact €/mo) + Apply.
 *  • Engine & autonomy — manual engine runs (bid/harvest/retail/dayparting) +
 *    autonomy state with Halt / Resume kill-switch.
 * Reuses the existing audited backend; all writes default to pending/dry-run.
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import { Search, Zap, FlaskConical, Trash2, Check, TrendingUp, ShieldAlert, RefreshCw, Play, Pause, Sparkles, Plus } from 'lucide-react'
import { getBackendUrl } from '@/lib/backend-url'
import { CATALOG, CATEGORIES, CATALOG_COUNT, type AutoTemplate } from './catalog'
import { RuleBuilder } from './RuleBuilder'
import { PLAYBOOKS, playbookTemplates } from './playbooks'
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

const TABS = [
  { k: 'library', label: 'Library' }, { k: 'playbooks', label: 'Playbooks' }, { k: 'active', label: 'Active rules' },
  { k: 'dayparting', label: 'Dayparting' }, { k: 'recs', label: 'Recommendations' }, { k: 'competitive', label: 'Competitive' },
  { k: 'retail', label: 'Retail' }, { k: 'budget', label: 'Budgets' }, { k: 'engine', label: 'Engine & autonomy' },
  { k: 'guardrails', label: 'Guardrails' }, { k: 'health', label: 'Health' },
]
const eur = (c: number | null | undefined) => (c == null ? '—' : new Intl.NumberFormat('en-IE', { style: 'currency', currency: 'EUR', maximumFractionDigits: 0 }).format(c / 100))
const post = (path: string, body?: unknown) => fetch(`${getBackendUrl()}/api/advertising/${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined })
const patch = (id: string, body: Record<string, unknown>) => fetch(`${getBackendUrl()}/api/advertising/automation-rules/${id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })

export function AutomationHub({ initialRules, initialState }: { initialRules: Rule[]; initialState: State | null }) {
  const [tab, setTab] = useState('library')
  const [rules, setRules] = useState<Rule[]>(initialRules.filter((r) => r.domain === 'advertising'))
  const [state, setState] = useState<State | null>(initialState)
  const [cat, setCat] = useState('All')
  const [q, setQ] = useState('')
  const [busy, setBusy] = useState<string | null>(null)
  const [recs, setRecs] = useState<RecResp | null>(null)
  const [engineMsg, setEngineMsg] = useState<Record<string, string>>({})
  const [showBuilder, setShowBuilder] = useState(false)
  const [libVisible, setLibVisible] = useState(48)

  const refetchRules = useCallback(async () => {
    const d = await fetch(`${getBackendUrl()}/api/advertising/automation-rules`, { cache: 'no-store' }).then((r) => r.json()).catch(() => ({ items: [] }))
    setRules((d.items ?? []).filter((r: Rule) => r.domain === 'advertising'))
  }, [])
  const refetchState = useCallback(async () => {
    const d = await fetch(`${getBackendUrl()}/api/advertising/automation/state`, { cache: 'no-store' }).then((r) => r.json()).catch(() => null)
    setState(d)
  }, [])
  useEffect(() => {
    void fetch(`${getBackendUrl()}/api/advertising/recommendations?limit=80`, { cache: 'no-store' }).then((r) => r.json()).then(setRecs).catch(() => {})
  }, [])

  const ruleNames = useMemo(() => new Set(rules.map((r) => r.name)), [rules])
  const liveCount = rules.filter((r) => r.enabled && !r.dryRun).length
  const activeCount = rules.filter((r) => r.enabled).length

  const enableTemplate = async (t: AutoTemplate) => {
    setBusy(t.id)
    try {
      await post('automation-rules', { name: t.name, description: t.desc, trigger: t.trigger, conditions: t.conditions, actions: t.actions, maxExecutionsPerDay: t.maxExecutionsPerDay, maxValueCentsEur: t.maxValueCentsEur ?? null, maxDailyAdSpendCentsEur: t.maxDailyAdSpendCentsEur ?? null })
      await refetchRules()
    } finally { setBusy(null) }
  }
  const enablePlaybook = async (pid: string) => {
    const pb = PLAYBOOKS.find((p) => p.id === pid); if (!pb) return
    setBusy(`pb:${pid}`)
    try {
      for (const t of playbookTemplates(pb)) {
        if (ruleNames.has(t.name)) continue
        await post('automation-rules', { name: t.name, description: t.desc, trigger: t.trigger, conditions: t.conditions, actions: t.actions, maxExecutionsPerDay: t.maxExecutionsPerDay, maxValueCentsEur: t.maxValueCentsEur ?? null, maxDailyAdSpendCentsEur: t.maxDailyAdSpendCentsEur ?? null })
      }
      await refetchRules()
    } finally { setBusy(null) }
  }
  const toggleEnabled = async (r: Rule) => { setBusy(r.id); try { await patch(r.id, { enabled: !r.enabled }); await refetchRules() } finally { setBusy(null) } }
  const toggleLive = async (r: Rule) => {
    if (r.dryRun && typeof window !== 'undefined' && !window.confirm(`Run "${r.name}" LIVE? It will make real changes to your campaigns (subject to your guardrails + per-campaign allowlist).`)) return
    setBusy(r.id); try { await patch(r.id, { dryRun: !r.dryRun }); await refetchRules() } finally { setBusy(null) }
  }
  const testRule = async (r: Rule) => { setBusy(r.id); try { const res = await post(`automation-rules/${r.id}/test`).then((x) => x.json()).catch(() => null); setEngineMsg((m) => ({ ...m, [r.id]: res ? `Tested · ${res.matched ?? res.matches ?? 0} match(es)` : 'Tested' })) } finally { setBusy(null) } }
  const deleteRule = async (r: Rule) => { if (typeof window !== 'undefined' && !window.confirm(`Delete "${r.name}"?`)) return; setBusy(r.id); try { await fetch(`${getBackendUrl()}/api/advertising/automation-rules/${r.id}`, { method: 'DELETE' }); await refetchRules() } finally { setBusy(null) } }
  const applyRec = async (rec: Rec) => { setBusy(rec.id); try { await post('recommendations/apply', { id: rec.id, kind: rec.apply?.kind, payload: rec.apply?.payload }); await fetch(`${getBackendUrl()}/api/advertising/recommendations?limit=80`, { cache: 'no-store' }).then((r) => r.json()).then(setRecs) } finally { setBusy(null) } }
  const runEngine = async (key: string, path: string, label: string) => {
    if (typeof window !== 'undefined' && !window.confirm(`Run ${label} now? It honours each rule's dry-run setting (dry-run rules only preview).`)) return
    setBusy(key); setEngineMsg((m) => ({ ...m, [key]: 'Running…' }))
    try { const res = await post(path, {}).then((x) => x.json()).catch(() => null); setEngineMsg((m) => ({ ...m, [key]: res ? (res.message ?? `Done · ${res.applied ?? res.count ?? res.changed ?? 0} action(s)`) : 'Done' })) } finally { setBusy(null) }
  }
  const setHalt = async (halt: boolean) => { setBusy('halt'); try { await post(halt ? 'automation/halt' : 'automation/resume', halt ? { reason: 'Manual halt from console' } : undefined); await refetchState() } finally { setBusy(null) } }

  const filtered = useMemo(() => {
    const ql = q.trim().toLowerCase()
    return CATALOG.filter((t) => (cat === 'All' || t.category === cat) && (!ql || t.name.toLowerCase().includes(ql) || t.desc.toLowerCase().includes(ql) || t.category.toLowerCase().includes(ql)))
  }, [cat, q])

  return (
    <div className="az-wrap">
      <div className="az-listhead"><span className="title"><Zap size={18} style={{ marginRight: 6, color: 'var(--orange)' }} />Automation</span><span style={{ flex: 1 }} /></div>

      <div className="az-hero">
        <div className="az-stat"><div className="k">Ready automations</div><div className="v">{CATALOG_COUNT}</div><div className="s">+ unlimited custom rules</div></div>
        <div className="az-stat"><div className="k">Active rules</div><div className="v">{activeCount}</div><div className="s">{liveCount} live · {activeCount - liveCount} dry-run</div></div>
        <div className="az-stat"><div className="k">Opportunity / mo</div><div className="v" style={{ color: 'var(--green)' }}>{recs ? eur(recs.potentialMonthlyImpactCents) : '…'}</div><div className="s">{recs?.recommendations?.length ?? 0} recommendations</div></div>
        <div className="az-stat"><div className="k">Engine</div><div className="v" style={{ color: state?.effectivelyStopped ? '#cc1100' : 'var(--green)' }}>{state?.effectivelyStopped ? 'Halted' : state?.autonomy ?? 'AUTO'}</div><div className="s">{state?.halted ? 'kill-switch on' : 'running'}</div></div>
      </div>

      <div className="az-tabs">{TABS.map((t) => <button key={t.k} className={`az-tab ${tab === t.k ? 'on' : ''}`} onClick={() => setTab(t.k)}>{tab === t.k && <span className="ck">✔</span>}{t.label}{t.k === 'active' && rules.length ? ` (${rules.length})` : ''}</button>)}</div>

      {tab === 'library' && <>
        <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap', marginBottom: 4 }}>
          <div className="az-search" style={{ minWidth: 300 }}><Search size={15} /><input placeholder="Search automations…" value={q} onChange={(e) => { setQ(e.target.value); setLibVisible(48) }} /></div>
          <span style={{ color: 'var(--ink2)', fontSize: 12 }}>{filtered.length} of {CATALOG_COUNT}</span>
          <span style={{ flex: 1 }} />
          <button className="az-btn dark" onClick={() => setShowBuilder(true)}><Plus size={15} />Build custom rule</button>
        </div>
        <div className="az-cats">{CATEGORIES.map((c) => <button key={c} className={`az-cat ${cat === c ? 'on' : ''}`} onClick={() => { setCat(c); setLibVisible(48) }}>{c}</button>)}</div>
        <div className="az-libgrid">
          {filtered.slice(0, libVisible).map((t) => {
            const added = ruleNames.has(t.name)
            return (
              <div key={t.id} className={`az-tmpl ${t.marquee ? 'marquee' : ''}`}>
                <div className="top"><span className="ic">{t.icon}</span><span className="nm">{t.name}</span></div>
                <div className="cat">{t.category}{t.marquee ? ' · ★ flagship' : ''}</div>
                <div className="d">{t.desc}</div>
                <div className="foot">
                  <span className="trg">{t.trigger === 'SCHEDULE' ? 'SCHEDULED' : t.trigger.replace(/_/g, ' ')}</span>
                  <span style={{ flex: 1 }} />
                  {added
                    ? <button className="az-btn" onClick={() => setTab('active')}><Check size={14} />In your rules</button>
                    : <button className="az-btn dark" disabled={busy === t.id} onClick={() => void enableTemplate(t)}>{busy === t.id ? 'Adding…' : 'Add'}</button>}
                </div>
              </div>
            )
          })}
        </div>
        {filtered.length > libVisible && <div style={{ textAlign: 'center', padding: '14px 0' }}><button className="az-btn" onClick={() => setLibVisible((v) => v + 60)}>Load {Math.min(60, filtered.length - libVisible)} more · {filtered.length - libVisible} left</button></div>}
        <div style={{ color: 'var(--ink2)', fontSize: 12, padding: '14px 2px' }}>Every automation is added <b>disabled + in dry-run</b> — flip it on (and later to live) from the Active rules tab when you’re ready. Need something bespoke? <button className="az-link" onClick={() => setShowBuilder(true)}>Build a custom rule</button>.</div>
      </>}

      {tab === 'playbooks' && <>
        <div style={{ color: 'var(--ink2)', fontSize: 12.5, padding: '4px 2px 14px' }}>Adopt a whole strategy in one click — each playbook adds several coordinated automations at once (disabled + dry-run, as always).</div>
        <div className="az-libgrid">
          {PLAYBOOKS.map((pb) => {
            const tmpls = playbookTemplates(pb)
            const have = tmpls.filter((t) => ruleNames.has(t.name)).length
            const all = tmpls.length > 0 && have === tmpls.length
            return (
              <div key={pb.id} className="az-tmpl marquee">
                <div className="top"><span className="ic">{pb.icon}</span><span className="nm">{pb.name}</span></div>
                <div className="cat">{pb.goal} · {tmpls.length} automations</div>
                <div className="d">{pb.desc}</div>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginBottom: 10 }}>{tmpls.map((t) => <span key={t.id} className="trg" style={{ background: 'var(--bg2)', borderRadius: 5, padding: '2px 6px', fontSize: 10, fontWeight: 600, color: 'var(--ink2)' }}>{t.icon} {t.name}</span>)}</div>
                <div className="foot"><span style={{ flex: 1 }} />{all ? <button className="az-btn" onClick={() => setTab('active')}><Check size={14} />Active ({have})</button> : <button className="az-btn dark" disabled={busy === `pb:${pb.id}`} onClick={() => void enablePlaybook(pb.id)}>{busy === `pb:${pb.id}` ? 'Adding…' : have > 0 ? `Add ${tmpls.length - have} more` : 'Activate playbook'}</button>}</div>
              </div>
            )
          })}
        </div>
      </>}

      {tab === 'active' && <div style={{ paddingTop: 4 }}>
        {rules.length === 0 && <div className="az-empty" style={{ border: '1px solid var(--divider)', borderRadius: 10 }}>No rules yet — add some from the Library.</div>}
        {rules.map((r) => (
          <div key={r.id} className="az-rule">
            <button className={`az-toggle ${r.enabled ? 'on' : ''}`} disabled={busy === r.id} onClick={() => void toggleEnabled(r)} aria-label="Enable rule" title={r.enabled ? 'Enabled' : 'Disabled'}><i /></button>
            <div className="nm"><div className="t">{r.name}</div><div className="d2">{r.description}</div></div>
            <span className="trg" style={{ background: 'var(--bg2)', borderRadius: 5, padding: '2px 7px', fontSize: 10, fontWeight: 700, color: 'var(--ink2)' }}>{r.trigger === 'SCHEDULE' ? 'SCHEDULED' : r.trigger.replace(/_/g, ' ')}</span>
            <div className="stat"><b>{r.executionCount ?? 0}</b>runs</div>
            <button className={`az-live ${r.dryRun ? 'dry' : 'on'}`} disabled={busy === r.id} onClick={() => void toggleLive(r)} title="Toggle dry-run / live">{r.dryRun ? 'Dry run' : 'LIVE'}</button>
            <button className="az-btn" disabled={busy === r.id} onClick={() => void testRule(r)} title="Test against current data"><FlaskConical size={14} /></button>
            <button className="az-kebab" disabled={busy === r.id} onClick={() => void deleteRule(r)} title="Delete" style={{ color: '#cc1100' }}><Trash2 size={15} /></button>
            {engineMsg[r.id] && <span style={{ color: 'var(--ink2)', fontSize: 11 }}>{engineMsg[r.id]}</span>}
          </div>
        ))}
      </div>}

      {tab === 'recs' && <div style={{ paddingTop: 4 }}>
        {!recs && <div className="az-empty">Loading recommendations…</div>}
        {recs && (recs.recommendations ?? []).length === 0 && <div className="az-empty" style={{ border: '1px solid var(--divider)', borderRadius: 10 }}>No recommendations right now — you’re dialled in. 🎉</div>}
        {recs && (recs.recommendations ?? []).map((rec) => (
          <div key={rec.id} className="az-rec">
            <span className={`sev ${rec.severity}`} />
            <div className="body"><div className="t">{rec.title}{rec.estImpactCents ? <span style={{ color: 'var(--green)', fontWeight: 700, marginLeft: 8 }}>{eur(rec.estImpactCents)}/mo</span> : null}</div><div className="d">{rec.detail}</div></div>
            <span className="trg" style={{ background: 'var(--bg2)', borderRadius: 5, padding: '2px 8px', fontSize: 10.5, fontWeight: 700, color: 'var(--ink2)', alignSelf: 'center' }}>{rec.category}</span>
            {rec.apply && <button className="az-btn dark" disabled={busy === rec.id} onClick={() => void applyRec(rec)} style={{ alignSelf: 'center' }}>{busy === rec.id ? 'Applying…' : 'Apply'}</button>}
          </div>
        ))}
      </div>}

      {tab === 'engine' && <div style={{ paddingTop: 4 }}>
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

      {showBuilder && <RuleBuilder onClose={() => setShowBuilder(false)} onSaved={() => { void refetchRules() }} />}
    </div>
  )
}
