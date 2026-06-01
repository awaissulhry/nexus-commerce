'use client'

/**
 * Trading Desk — Automation command center. The hands-off operating brain:
 *  - Health strip (live/dry/disabled, 30d executions, success rate, time saved, risks)
 *  - Rules: list with mode (Off/Dry-run/Live) + inline toggles, conditions/actions, edit/delete
 *  - Strategies: categorized templates (Pacvue-style) → one click into the builder
 *  - Activity: recent rule executions (change log)
 *  - Native rule Builder: When (trigger) → If (conditions) → Then (actions) → Guardrails
 *
 * Reuses the shared rule catalog (TRIGGERS/CONDITION_FIELDS/OPS/ACTION_TYPES/
 * TEMPLATES) so it speaks the engine's exact language. Wired to
 * /advertising/automation-rules (CRUD), /automation-health, /automation-rule-executions.
 */

import { useCallback, useEffect, useState } from 'react'
import { Plus, RefreshCw, Sparkles, X, Trash2, Pencil, Wand2 } from 'lucide-react'
import { getBackendUrl } from '@/lib/backend-url'
import { TRIGGERS, CONDITION_FIELDS, OPS, ACTION_TYPES, TEMPLATES, type RuleTemplate } from '@/app/marketing/advertising/_shared/rule-catalog'
import { AutonomyControlCenter } from './AutonomyControlCenter'
import { DaypartingTab } from './DaypartingTab'
import { BudgetTab } from './BudgetTab'
import { RetailGuardTab } from './RetailGuardTab'

interface Rule {
  id: string; name: string; description?: string | null; trigger: string
  conditions?: unknown; actions?: unknown; enabled: boolean; dryRun: boolean
  scopeMarketplace?: string | null; maxExecutionsPerDay?: number | null; maxDailyAdSpendCentsEur?: number | null
  executionCount?: number; lastExecutedAt?: string | null
}
interface Health { rules: { total: number; live: number; dryRun: number; disabled: number }; executions30d: { total: number; success: number; partial: number; failed: number; dryRun: number; noMatch: number }; successRatePct: number | null; estTimeSavedMinutes?: number; risks: { stuckInDryRun: number; disabled: number; recentFailures: number; noManaging: boolean } }
interface Execution { id: string; status: string; startedAt?: string | null; rule?: { name?: string; trigger?: string } }
interface Cond { field: string; op: string; value: string }
interface Act { type: string; params: Record<string, string> }
interface Draft { id?: string; name: string; trigger: string; conditions: Cond[]; actions: Act[]; maxExec: string; maxSpendEur: string; scope: string }

const TRIG_LABEL = Object.fromEntries(TRIGGERS.map((t) => [t.key, t.label] as const))
const ACT_LABEL = Object.fromEntries(ACTION_TYPES.map((a) => [a.type, a.label] as const))
const OP_LABEL = Object.fromEntries(OPS.map((o) => [o.op, o.label] as const))
const FIELD_LABEL = Object.fromEntries(CONDITION_FIELDS.map((f) => [f.field, f.label] as const))
const MARKETS = ['', 'IT', 'DE', 'FR', 'ES']
const when = (d?: string | null) => (d ? new Date(d).toLocaleDateString() : 'never')
const defaultParams = (type: string): Record<string, string> => { const a = ACTION_TYPES.find((x) => x.type === type); const o: Record<string, string> = {}; for (const p of a?.params ?? []) o[p.key] = String(p.default ?? ''); return o }

function draftFromTemplate(t: RuleTemplate): Draft {
  return {
    name: t.name, trigger: t.trigger,
    conditions: t.conditions.map((c) => ({ field: c.field, op: c.op, value: String(c.value) })),
    actions: t.actions.map((a) => { const type = String(a.type); const params = defaultParams(type); for (const k of Object.keys(a)) if (k !== 'type') params[k] = String(a[k]); return { type, params } }),
    maxExec: String(t.maxExecutionsPerDay ?? 10), maxSpendEur: t.maxDailyAdSpendCentsEur ? String(t.maxDailyAdSpendCentsEur / 100) : '100', scope: '',
  }
}
function draftFromRule(r: Rule): Draft {
  const conds = (Array.isArray(r.conditions) ? r.conditions : []) as Array<{ field: string; op: string; value: number }>
  const acts = (Array.isArray(r.actions) ? r.actions : []) as Array<Record<string, unknown>>
  return {
    id: r.id, name: r.name, trigger: r.trigger,
    conditions: conds.map((c) => ({ field: c.field, op: c.op, value: String(c.value) })),
    actions: acts.map((a) => { const type = String(a.type); const params = defaultParams(type); for (const k of Object.keys(a)) if (k !== 'type') params[k] = String(a[k]); return { type, params } }),
    maxExec: r.maxExecutionsPerDay != null ? String(r.maxExecutionsPerDay) : '10',
    maxSpendEur: r.maxDailyAdSpendCentsEur != null ? String(r.maxDailyAdSpendCentsEur / 100) : '100',
    scope: r.scopeMarketplace ?? '',
  }
}
const newDraft = (): Draft => ({ name: '', trigger: TRIGGERS[0].key, conditions: [{ field: CONDITION_FIELDS[0].field, op: 'gte', value: '' }], actions: [{ type: ACTION_TYPES[0].type, params: defaultParams(ACTION_TYPES[0].type) }], maxExec: '10', maxSpendEur: '100', scope: '' })

export function AutomationClient({ initialRules, initialHealth }: { initialRules: Rule[]; initialHealth: Health | null }) {
  const [tab, setTab] = useState<'rules' | 'strategies' | 'dayparting' | 'budget' | 'retail' | 'activity'>('rules')
  const [rules, setRules] = useState<Rule[]>(initialRules)
  const [health, setHealth] = useState<Health | null>(initialHealth)
  const [execs, setExecs] = useState<Execution[] | null>(null)
  const [loading, setLoading] = useState(false)
  const [busy, setBusy] = useState<string | null>(null)
  const [draft, setDraft] = useState<Draft | null>(null)
  const [saving, setSaving] = useState(false)

  const refetch = useCallback(async () => {
    setLoading(true)
    try {
      const b = getBackendUrl()
      const [r, h] = await Promise.all([
        fetch(`${b}/api/advertising/automation-rules`, { cache: 'no-store' }).then((x) => x.json()).catch(() => ({ items: [] })),
        fetch(`${b}/api/advertising/automation-health`, { cache: 'no-store' }).then((x) => x.json()).catch(() => null),
      ])
      setRules((r.items ?? []) as Rule[]); setHealth(h as Health)
    } finally { setLoading(false) }
  }, [])
  useEffect(() => { void refetch() }, [refetch])
  useEffect(() => {
    if (tab !== 'activity' || execs !== null) return
    void fetch(`${getBackendUrl()}/api/advertising/automation-rule-executions?limit=100`, { cache: 'no-store' }).then((x) => x.json()).then((d) => setExecs((d.items ?? []) as Execution[])).catch(() => setExecs([]))
  }, [tab, execs])

  const patch = async (id: string, body: Record<string, unknown>) => { setBusy(id); try { await fetch(`${getBackendUrl()}/api/advertising/automation-rules/${id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }); await refetch() } finally { setBusy(null) } }
  const del = async (id: string) => { if (!confirm('Delete this rule?')) return; setBusy(id); try { await fetch(`${getBackendUrl()}/api/advertising/automation-rules/${id}`, { method: 'DELETE' }); await refetch() } finally { setBusy(null) } }

  const save = async () => {
    if (!draft || !draft.name.trim()) return
    setSaving(true)
    try {
      const body: Record<string, unknown> = {
        name: draft.name.trim(), trigger: draft.trigger,
        conditions: draft.conditions.filter((c) => c.field && c.value !== '').map((c) => ({ field: c.field, op: c.op, value: Number(c.value) })),
        actions: draft.actions.map((a) => { const def = ACTION_TYPES.find((x) => x.type === a.type); const o: Record<string, unknown> = { type: a.type }; for (const p of def?.params ?? []) { const v = a.params[p.key]; o[p.key] = p.type === 'number' ? Number(v) : v } return o }),
        maxExecutionsPerDay: draft.maxExec ? Number(draft.maxExec) : undefined,
        maxDailyAdSpendCentsEur: draft.maxSpendEur ? Math.round(Number(draft.maxSpendEur) * 100) : undefined,
        scopeMarketplace: draft.scope || undefined,
      }
      const url = `${getBackendUrl()}/api/advertising/automation-rules${draft.id ? `/${draft.id}` : ''}`
      await fetch(url, { method: draft.id ? 'PATCH' : 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
      setDraft(null); await refetch()
    } finally { setSaving(false) }
  }

  const mode = (r: Rule) => (!r.enabled ? { cls: 'off', label: 'Off' } : r.dryRun ? { cls: 'dry', label: 'Dry-run' } : { cls: 'live', label: 'Live' })
  const condText = (r: Rule) => (Array.isArray(r.conditions) ? (r.conditions as Cond[]) : []).map((c) => `${FIELD_LABEL[c.field] ?? c.field} ${OP_LABEL[c.op] ?? c.op} ${c.value}`)
  const actText = (r: Rule) => (Array.isArray(r.actions) ? (r.actions as Array<{ type: string }>) : []).map((a) => ACT_LABEL[a.type] ?? a.type)

  return (
    <>
      <div className="top">
        <div><h1>Automation</h1><div className="sub">Rules engine · {health?.rules.live ?? 0} live · {health?.rules.dryRun ?? 0} dry-run</div></div>
        <span className="spacer" />
        <button className="ctl acc" onClick={() => setDraft(newDraft())}><Plus size={14} />New rule</button>
        <button className="ctl" onClick={() => void refetch()} title="Refresh"><RefreshCw size={14} className={loading ? 'spin' : ''} /></button>
      </div>

      <div className="scroll">
        {/* TD.0 — Autonomy Control Center (dial + circuit-breaker). */}
        <AutonomyControlCenter />
        {/* Health strip */}
        <div className="statrow">
          <div className="stat"><div className="sv" style={{ color: 'var(--green)' }}>{health?.rules.live ?? '—'}</div><div className="sl">Live</div></div>
          <div className="stat"><div className="sv" style={{ color: 'var(--amber)' }}>{health?.rules.dryRun ?? '—'}</div><div className="sl">Dry-run</div></div>
          <div className="stat"><div className="sv" style={{ color: 'var(--slate)' }}>{health?.rules.disabled ?? '—'}</div><div className="sl">Disabled</div></div>
          <div className="stat"><div className="sv">{health?.executions30d.total ?? '—'}</div><div className="sl">Runs · 30d</div></div>
          <div className="stat"><div className="sv">{health?.successRatePct != null ? `${health.successRatePct}%` : '—'}</div><div className="sl">Success rate</div></div>
          {health?.estTimeSavedMinutes != null && <div className="stat"><div className="sv">{Math.round(health.estTimeSavedMinutes / 60)}h</div><div className="sl">Est. time saved</div></div>}
          <div className="stat" style={{ display: 'flex', alignItems: 'center' }}>{health && health.risks.noManaging ? <span className="riskbadge">Nothing live</span> : health && health.risks.recentFailures > 0 ? <span className="riskbadge">{health.risks.recentFailures} recent failures</span> : <span className="riskok">Healthy</span>}</div>
        </div>

        <div className="cocktabs">
          <button className={tab === 'rules' ? 'on' : ''} onClick={() => setTab('rules')}>Rules ({rules.length})</button>
          <button className={tab === 'strategies' ? 'on' : ''} onClick={() => setTab('strategies')}>Strategies</button>
          <button className={tab === 'dayparting' ? 'on' : ''} onClick={() => setTab('dayparting')}>Dayparting</button>
          <button className={tab === 'budget' ? 'on' : ''} onClick={() => setTab('budget')}>Budget</button>
          <button className={tab === 'retail' ? 'on' : ''} onClick={() => setTab('retail')}>Retail guard</button>
          <button className={tab === 'activity' ? 'on' : ''} onClick={() => setTab('activity')}>Activity</button>
        </div>

        {tab === 'rules' && (
          rules.length === 0 ? (
            <div className="card"><div className="bd" style={{ textAlign: 'center', padding: 40 }}>
              <div className="ph-hero" style={{ margin: '0 auto 14px' }}><Wand2 /></div>
              <h2 style={{ margin: '0 0 6px' }}>No rules yet</h2>
              <p style={{ color: 'var(--ink3)', maxWidth: 460, margin: '0 auto 16px', lineHeight: 1.6 }}>Start from a <b>Strategy</b> template or build your own. New rules start Off + dry-run for safety.</p>
              <button className="btn ok" onClick={() => setTab('strategies')}><Sparkles size={14} />Browse strategies</button>
            </div></div>
          ) : (
            <div className="card"><div className="tablewrap"><table>
              <thead><tr><th className="l">Rule</th><th className="l">When</th><th className="l">If / Then</th><th>Mode</th><th>Last run</th><th>Runs</th><th></th></tr></thead>
              <tbody>
                {rules.map((r) => { const m = mode(r); return (
                  <tr key={r.id}>
                    <td className="l"><div style={{ fontWeight: 650 }}>{r.name}</div>{r.scopeMarketplace && <span className="pill n" style={{ marginTop: 3 }}>{r.scopeMarketplace}</span>}</td>
                    <td className="l"><span className="trg">{TRIG_LABEL[r.trigger] ?? r.trigger}</span></td>
                    <td className="l"><div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, maxWidth: 360 }}>{condText(r).map((c, i) => <span key={`c${i}`} className="condchip">{c}</span>)}{condText(r).length > 0 && actText(r).length > 0 && <span style={{ color: 'var(--ink3)' }}>→</span>}{actText(r).map((a, i) => <span key={`a${i}`} className="pill b">{a}</span>)}</div></td>
                    <td><span className={`modepill ${m.cls}`}>{m.label}</span></td>
                    <td className="num">{when(r.lastExecutedAt)}</td>
                    <td className="num">{r.executionCount ?? 0}</td>
                    <td><div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end' }}>
                      <button className="iact" disabled={busy === r.id} onClick={() => void patch(r.id, { enabled: !r.enabled })}>{r.enabled ? 'Disable' : 'Enable'}</button>
                      {r.enabled && <button className="iact" disabled={busy === r.id} onClick={() => void patch(r.id, { dryRun: !r.dryRun })}>{r.dryRun ? 'Go live' : 'Dry-run'}</button>}
                      <button className="iact" onClick={() => setDraft(draftFromRule(r))} title="Edit"><Pencil size={12} /></button>
                      <button className="iact" disabled={busy === r.id} onClick={() => void del(r.id)} title="Delete"><Trash2 size={12} /></button>
                    </div></td>
                  </tr>
                ) })}
              </tbody>
            </table></div>
            <div className="legend" style={{ padding: '12px 14px' }}><span><b>Mode</b> — Off: inactive · Dry-run: evaluates + logs, no writes · Live: applies via the gated path. New rules start Off + dry-run.</span></div>
            </div>
          )
        )}

        {tab === 'strategies' && (
          <>
            {(['Sales', 'Relevancy', 'Other'] as const).map((cat) => {
              const items = TEMPLATES.filter((t) => t.category === cat)
              if (items.length === 0) return null
              return (
                <div key={cat} style={{ marginBottom: 18 }}>
                  <div className="sectlbl">{cat}</div>
                  <div className="tplgrid">
                    {items.map((t) => (
                      <div key={t.key} className="tplcard">
                        <div className="tc">{TRIG_LABEL[t.trigger] ?? t.trigger}</div>
                        <div className="tn">{t.name}</div>
                        <div className="td2">{t.description}</div>
                        <div className="ta"><button className="btn ok sm" onClick={() => setDraft(draftFromTemplate(t))}><Plus size={13} />Use this</button></div>
                      </div>
                    ))}
                  </div>
                </div>
              )
            })}
          </>
        )}

        {tab === 'dayparting' && <DaypartingTab />}
        {tab === 'budget' && <BudgetTab />}
        {tab === 'retail' && <RetailGuardTab />}

        {tab === 'activity' && (
          <div className="card"><div className="tablewrap"><table>
            <thead><tr><th className="l">Rule</th><th className="l">Trigger</th><th>Status</th><th>When</th></tr></thead>
            <tbody>
              {execs === null && <tr><td colSpan={4} className="empty">Loading…</td></tr>}
              {execs && execs.length === 0 && <tr><td colSpan={4} className="empty">No rule executions yet.</td></tr>}
              {execs?.map((e) => (
                <tr key={e.id}>
                  <td className="l">{e.rule?.name ?? '—'}</td>
                  <td className="l"><span className="trg">{e.rule?.trigger ? (TRIG_LABEL[e.rule.trigger] ?? e.rule.trigger) : '—'}</span></td>
                  <td><span className={`pill ${e.status === 'SUCCESS' ? 'g' : e.status === 'FAILED' ? 'r' : e.status === 'PARTIAL' ? 'a' : 'n'}`}>{e.status}</span></td>
                  <td className="num">{e.startedAt ? new Date(e.startedAt).toLocaleString() : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table></div></div>
        )}
      </div>

      {draft && <RuleBuilder draft={draft} setDraft={setDraft} onSave={() => void save()} saving={saving} />}
    </>
  )
}

function RuleBuilder({ draft, setDraft, onSave, saving }: { draft: Draft; setDraft: (d: Draft | null) => void; onSave: () => void; saving: boolean }) {
  const up = (patch: Partial<Draft>) => setDraft({ ...draft, ...patch })
  const setCond = (i: number, patch: Partial<Cond>) => up({ conditions: draft.conditions.map((c, j) => (j === i ? { ...c, ...patch } : c)) })
  const setAct = (i: number, type: string) => up({ actions: draft.actions.map((a, j) => (j === i ? { type, params: defaultParams(type) } : a)) })
  const setActParam = (i: number, key: string, value: string) => up({ actions: draft.actions.map((a, j) => (j === i ? { ...a, params: { ...a.params, [key]: value } } : a)) })

  return (
    <div className="modal-bg" onClick={() => setDraft(null)}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="mh"><Wand2 size={16} style={{ stroke: 'var(--brand)' }} />{draft.id ? 'Edit rule' : 'New rule'}<button className="x" onClick={() => setDraft(null)}><X size={18} /></button></div>
        <div className="mb">
          <div className="field"><label>Rule name</label><input className="inp" value={draft.name} onChange={(e) => up({ name: e.target.value })} placeholder="e.g. Cut wasted spend on DE" /></div>

          <div className="block">
            <div className="bl">When</div>
            <select className="inp" value={draft.trigger} onChange={(e) => up({ trigger: e.target.value })}>{TRIGGERS.map((t) => <option key={t.key} value={t.key}>{t.label} — {t.blurb}</option>)}</select>
          </div>

          <div className="block">
            <div className="bl">If — all conditions match</div>
            {draft.conditions.map((c, i) => {
              const fld = CONDITION_FIELDS.find((f) => f.field === c.field)
              return (
                <div key={i}>
                  <div className="crow">
                    <select className="inp sm2" value={c.field} onChange={(e) => setCond(i, { field: e.target.value })}>{CONDITION_FIELDS.map((f) => <option key={f.field} value={f.field}>{f.label}</option>)}</select>
                    <select className="inp sm2" value={c.op} onChange={(e) => setCond(i, { op: e.target.value })}>{OPS.map((o) => <option key={o.op} value={o.op}>{o.label}</option>)}</select>
                    <input className="inp sm2" type="number" step="any" value={c.value} onChange={(e) => setCond(i, { value: e.target.value })} placeholder="value" />
                    <button className="xrow" onClick={() => up({ conditions: draft.conditions.filter((_, j) => j !== i) })}><X size={14} /></button>
                  </div>
                  {fld && <div className="crow" style={{ marginTop: -4 }}><div className="hintv">{fld.hint}</div></div>}
                </div>
              )
            })}
            <button className="addbtn" onClick={() => up({ conditions: [...draft.conditions, { field: CONDITION_FIELDS[0].field, op: 'gte', value: '' }] })}><Plus size={13} />Add condition</button>
          </div>

          <div className="block">
            <div className="bl">Then — do</div>
            {draft.actions.map((a, i) => {
              const def = ACTION_TYPES.find((x) => x.type === a.type)
              return (
                <div className="arow" key={i}>
                  <div className="ah">
                    <select className="inp sm2" value={a.type} onChange={(e) => setAct(i, e.target.value)}>{ACTION_TYPES.map((t) => <option key={t.type} value={t.type}>{t.label}</option>)}</select>
                    <button className="xrow" onClick={() => up({ actions: draft.actions.filter((_, j) => j !== i) })}><X size={14} /></button>
                  </div>
                  {def && def.params.length > 0 && (
                    <div className="ap">
                      {def.params.map((p) => (
                        <div key={p.key}>
                          <label>{p.label}</label>
                          {p.type === 'select'
                            ? <select className="inp sm2" value={a.params[p.key] ?? ''} onChange={(e) => setActParam(i, p.key, e.target.value)}>{(p.options ?? []).map((o) => <option key={o} value={o}>{o}</option>)}</select>
                            : <input className="inp sm2" type={p.type === 'number' ? 'number' : 'text'} value={a.params[p.key] ?? ''} onChange={(e) => setActParam(i, p.key, e.target.value)} />}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )
            })}
            <button className="addbtn" onClick={() => up({ actions: [...draft.actions, { type: ACTION_TYPES[0].type, params: defaultParams(ACTION_TYPES[0].type) }] })}><Plus size={13} />Add action</button>
          </div>

          <div className="block">
            <div className="bl">Guardrails</div>
            <div className="grd">
              <div><label style={{ fontSize: 11, color: 'var(--ink3)', fontWeight: 600 }}>Max runs / day</label><input className="inp sm2" type="number" value={draft.maxExec} onChange={(e) => up({ maxExec: e.target.value })} /></div>
              <div><label style={{ fontSize: 11, color: 'var(--ink3)', fontWeight: 600 }}>Max daily spend (€)</label><input className="inp sm2" type="number" value={draft.maxSpendEur} onChange={(e) => up({ maxSpendEur: e.target.value })} /></div>
              <div><label style={{ fontSize: 11, color: 'var(--ink3)', fontWeight: 600 }}>Scope market</label><select className="inp sm2" value={draft.scope} onChange={(e) => up({ scope: e.target.value })}>{MARKETS.map((m) => <option key={m} value={m}>{m || 'All markets'}</option>)}</select></div>
            </div>
          </div>
        </div>
        <div className="mf">
          <span className="note" style={{ marginRight: 'auto' }}>Saved Off + dry-run — enable it from the Rules list when ready.</span>
          <button className="btn no" onClick={() => setDraft(null)}>Cancel</button>
          <button className="btn ok" disabled={!draft.name.trim() || saving} onClick={onSave}>{saving ? 'Saving…' : draft.id ? 'Save rule' : 'Create rule'}</button>
        </div>
      </div>
    </div>
  )
}
