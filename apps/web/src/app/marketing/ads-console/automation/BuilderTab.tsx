'use client'

/**
 * RC6.3 — the unified Builder. Replaces the old limited RuleBuilder modal (6
 * triggers / 10 fields / 8 actions) and the Composer with one surface:
 *   · Guided  — pick a goal, tune a couple of numbers, name + ship (novice path)
 *   · Advanced — the full engine: any of 19 triggers, 19 condition fields, 9
 *     operators, AND/OR groups, all 26 actions with params, caps + market scope.
 * Both share one draft + a live plain-English preview, and a real "Create & test"
 * that runs the draft against current data (dry-run, no changes). Every rule is
 * created disabled + dry-run via POST /automation-rules.
 */

import { useEffect, useMemo, useState } from 'react'
import { Plus, Trash2, Check, FlaskConical, ShieldCheck, Wand2, Settings2, ArrowRight, ArrowLeft, Sparkles } from 'lucide-react'
import { getBackendUrl } from '@/lib/backend-url'
import { marketLabel } from '../_shared/amazonLinks'
import {
  TRIGGERS, OPS, ACTIONS, triggerDef, fieldDef, actionDef,
  suggestedFields, fieldSuffix, paramSuffix, condToRaw, paramToRaw, actionPhrase,
} from './vocab'
import { checkRuleLogic } from './synthetic-test'

interface CondRow { field: string; op: string; value: string }
interface ActRow { type: string; params: Record<string, string> }
interface Conn { marketplace: string }

const ACTION_CATS = [...new Set(ACTIONS.map((a) => a.cat))]
const opSym = (op: string) => OPS.find((o) => o.v === op)?.l ?? op
const seedParams = (type: string): Record<string, string> => Object.fromEntries((actionDef(type)?.params ?? []).map((p) => [p.k, String(p.def)]))
const defaultRow = (trigger: string): CondRow => ({ field: suggestedFields(trigger)[0]?.f ?? 'campaign.acos', op: 'gte', value: '' })

interface Goal { id: string; label: string; desc: string; trigger: string; groups: CondRow[][]; acts: ActRow[] }
const GUIDED_GOALS: Goal[] = [
  { id: 'margin', label: 'Protect margin', desc: 'Cut bids when a campaign’s ACOS climbs too high.', trigger: 'CAC_SPIKE', groups: [[{ field: 'campaign.acos', op: 'gte', value: '40' }]], acts: [{ type: 'bid_down', params: { target: 'ad_group', percent: '20' } }] },
  { id: 'waste', label: 'Cut wasted spend', desc: 'Drop keywords that burn spend without selling to the bid floor.', trigger: 'KEYWORD_WASTED_SPEND', groups: [[{ field: 'adTarget.spendCents', op: 'gte', value: '15' }]], acts: [{ type: 'lower_bid_to_floor', params: {} }] },
  { id: 'scale', label: 'Scale winners', desc: 'Raise the daily budget on campaigns beating your ROAS target.', trigger: 'CAMPAIGN_PERFORMANCE_BUDGET', groups: [[{ field: 'campaign.roas', op: 'gte', value: '4' }]], acts: [{ type: 'adjust_ad_budget', params: { percent: '20' } }] },
  { id: 'harvest', label: 'Harvest search terms', desc: 'Promote converting terms and negate wasteful ones, on a schedule.', trigger: 'SCHEDULE', groups: [[]], acts: [{ type: 'harvest_and_negate', params: { windowDays: '60', minOrders: '2', minSpendCents: '10' } }] },
  { id: 'cap', label: 'Stop overspend', desc: 'Pause every campaign when month-to-date spend hits your cap.', trigger: 'SCHEDULE', groups: [[{ field: 'budget.monthlySpendCents', op: 'gte', value: '2000' }]], acts: [{ type: 'pause_all_campaigns', params: {} }] },
  { id: 'alert', label: 'Just alert me', desc: 'No campaign changes — notify you when ACOS spikes.', trigger: 'CAC_SPIKE', groups: [[{ field: 'campaign.acos', op: 'gte', value: '50' }]], acts: [{ type: 'notify', params: { message: 'ACOS spike detected' } }] },
]

export function BuilderTab({ onSaved, onGoActive }: { onSaved: () => void; onGoActive: () => void }) {
  const [mode, setMode] = useState<'guided' | 'advanced'>('guided')
  const [step, setStep] = useState(1)            // guided step 1..3
  const [goal, setGoal] = useState('')
  const [name, setName] = useState('')
  const [trigger, setTrigger] = useState('CAC_SPIKE')
  const [groups, setGroups] = useState<CondRow[][]>([[{ field: 'campaign.acos', op: 'gte', value: '40' }]])
  const [acts, setActs] = useState<ActRow[]>([{ type: 'bid_down', params: seedParams('bid_down') }])
  const [maxPerDay, setMaxPerDay] = useState('20')
  const [maxSpend, setMaxSpend] = useState('100')
  const [maxValue, setMaxValue] = useState('')
  const [scope, setScope] = useState('')         // '' = all markets
  const [conns, setConns] = useState<Conn[]>([])
  const [saving, setSaving] = useState<false | 'save' | 'test'>(false)
  const [msg, setMsg] = useState('')
  const [testMsg, setTestMsg] = useState('')

  useEffect(() => { void fetch(`${getBackendUrl()}/api/advertising/connections`, { cache: 'no-store' }).then((r) => r.json()).then((d) => setConns((d.items ?? []).filter((c: { isActive?: boolean }) => c.isActive !== false))).catch(() => {}) }, [])

  const applyGoal = (g: Goal) => {
    setGoal(g.id); setTrigger(g.trigger)
    setGroups(g.groups.map((grp) => grp.map((c) => ({ ...c }))))
    setActs(g.acts.map((a) => ({ type: a.type, params: { ...seedParams(a.type), ...a.params } })))
    if (!name.trim()) setName(g.label)
    setStep(2)
  }

  const changeTrigger = (t: string) => { setTrigger(t); setGroups([[defaultRow(t)]]) }
  const setCond = (gi: number, ri: number, patch: Partial<CondRow>) => setGroups((gs) => gs.map((g, i) => i === gi ? g.map((c, j) => j === ri ? { ...c, ...patch } : c) : g))
  const addRow = (gi: number) => setGroups((gs) => gs.map((g, i) => i === gi ? [...g, defaultRow(trigger)] : g))
  const removeRow = (gi: number, ri: number) => setGroups((gs) => { const next = gs.map((g, i) => i === gi ? g.filter((_, j) => j !== ri) : g).filter((g) => g.length > 0); return next.length ? next : [[defaultRow(trigger)]] })
  const addGroup = () => setGroups((gs) => [...gs, [defaultRow(trigger)]])
  const setActType = (ai: number, type: string) => setActs((r) => r.map((x, i) => i === ai ? { type, params: seedParams(type) } : x))
  const setActParam = (ai: number, k: string, v: string) => setActs((r) => r.map((x, i) => i === ai ? { ...x, params: { ...x.params, [k]: v } } : x))
  const removeAct = (ai: number) => setActs((r) => (r.length > 1 ? r.filter((_, i) => i !== ai) : r))

  // ── draft → engine payload ──────────────────────────────────────────────────
  const keep = (c: CondRow) => !!c.field && (c.op === 'exists' || c.value.trim() !== '')
  const toLeaf = (c: CondRow) => {
    if (c.op === 'exists') return { field: c.field, op: 'exists' as const }
    if (c.op === 'in') return { field: c.field, op: 'in' as const, value: c.value.split(',').map((s) => s.trim()).filter(Boolean) }
    if (c.op === 'contains') return { field: c.field, op: 'contains' as const, value: c.value }
    return { field: c.field, op: c.op, value: condToRaw(fieldDef(c.field)?.unit ?? 'num', Number(c.value)) }
  }
  const conditions = useMemo(() => {
    const grp = groups.map((g) => g.filter(keep)).filter((g) => g.length > 0)
    if (grp.length === 0) return [] as unknown[]
    if (grp.length === 1) return grp[0].map(toLeaf)                              // flat AND
    return { kind: 'or', children: grp.map((g) => ({ kind: 'and', children: g.map((c) => ({ kind: 'leaf', ...toLeaf(c) })) })) }
  }, [groups])
  const buildActions = () => acts.map((a) => { const o: Record<string, unknown> = { type: a.type }; for (const p of actionDef(a.type)?.params ?? []) { const raw = a.params[p.k]; if (raw == null || raw === '') continue; o[p.k] = paramToRaw(p, raw) } return o })

  const previewSentence = useMemo(() => {
    const condText = groups
      .map((g) => g.filter(keep).map((c) => `${fieldDef(c.field)?.label ?? c.field} ${opSym(c.op)}${c.op === 'exists' ? '' : ` ${c.value}${fieldSuffix(fieldDef(c.field)?.unit ?? 'num')}`}`).join(' and '))
      .filter(Boolean).join('  — OR —  ')
    const actText = acts.map((a) => actionPhrase(a.type, a.params)).join(', and ')
    const trg = triggerDef(trigger)?.label.toLowerCase() ?? trigger
    return `When ${trg}${condText ? `, and ${condText}` : ''}, it will ${actText || '…'}.`
  }, [groups, acts, trigger])

  const valid = name.trim().length > 0 && acts.length > 0

  const create = async (runTest: boolean) => {
    if (!valid) return
    setSaving(runTest ? 'test' : 'save'); setMsg(''); setTestMsg('')
    try {
      const body = {
        name: name.trim(), description: `Custom rule — ${triggerDef(trigger)?.label ?? trigger}`,
        trigger, conditions, actions: buildActions(),
        maxExecutionsPerDay: Number(maxPerDay) || 20,
        maxDailyAdSpendCentsEur: Math.round((Number(maxSpend) || 100) * 100),
        ...(maxValue.trim() ? { maxValueCentsEur: Math.round(Number(maxValue) * 100) } : {}),
        ...(scope ? { scopeMarketplace: scope } : {}),
      }
      const res = await fetch(`${getBackendUrl()}/api/advertising/automation-rules`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
      const json = await res.json().catch(() => null)
      const ruleId: string | undefined = json?.rule?.id
      if (!res.ok || !ruleId) { setMsg('Could not create the rule — check the inputs and try again.'); return }
      if (runTest) {
        const { matched } = await checkRuleLogic(ruleId, conditions)
        setTestMsg(matched === true ? 'Engine check ✓ — fires correctly on a matching entity (dry-run, nothing changed).'
          : matched === false ? 'Engine check — a sample matching entity didn’t trigger; review your conditions.'
          : 'Engine check couldn’t run just now — the rule was still created.')
      }
      setMsg('Created — disabled + dry-run. Turn it on from Active rules when you’re ready.')
      onSaved()
    } finally { setSaving(false) }
  }

  // ── render pieces ───────────────────────────────────────────────────────────
  const paramInput = (ai: number, a: ActRow) => (actionDef(a.type)?.params ?? []).map((p) => {
    const v = a.params[p.k] ?? ''
    if (p.kind === 'sel') return <select key={p.k} value={v} onChange={(e) => setActParam(ai, p.k, e.target.value)}>{p.options?.map((o) => <option key={o.v} value={o.v}>{o.l}</option>)}</select>
    if (p.kind === 'text') return <input key={p.k} type="text" placeholder={p.label} value={v} onChange={(e) => setActParam(ai, p.k, e.target.value)} style={{ flex: 1, minWidth: 160 }} />
    return <span key={p.k} className="az-bld-num"><input type="number" step="any" placeholder={p.label} value={v} onChange={(e) => setActParam(ai, p.k, e.target.value)} title={p.label} /><i>{paramSuffix(p.kind)}</i></span>
  })

  const footer = (
    <div className="az-bld-foot">
      <div className="az-bld-preview"><Sparkles size={14} /><span>{previewSentence}</span></div>
      <div className="az-bld-actions">
        <label className="az-bld-name"><span>Rule name</span><input placeholder="e.g. Cut bids when ACOS ≥ 45%" value={name} onChange={(e) => setName(e.target.value)} /></label>
        <button className="az-btn" disabled={!valid || saving !== false} onClick={() => void create(true)}><FlaskConical size={14} />{saving === 'test' ? 'Testing…' : 'Create & test'}</button>
        <button className="az-btn dark" disabled={!valid || saving !== false} onClick={() => void create(false)}><Check size={15} />{saving === 'save' ? 'Creating…' : 'Create rule'}</button>
      </div>
      {(msg || testMsg) && <div className="az-bld-msg">{msg && <span className="ok"><Check size={13} /> {msg} <button className="az-link" onClick={onGoActive}>Go to Active rules →</button></span>}{testMsg && <span className="test">{testMsg}</span>}</div>}
      <div className="az-bld-safe"><ShieldCheck size={13} /> New rules always start <b>disabled + dry-run</b>. Caps and the kill-switch still apply once live.</div>
    </div>
  )

  const capsRow = (
    <div className="az-fp-sec">
      <h4>Guardrails &amp; scope</h4>
      <div className="az-bld-caps">
        <label><span>Max runs / day</span><input type="number" value={maxPerDay} onChange={(e) => setMaxPerDay(e.target.value)} /></label>
        <label><span>Max €/day affected</span><input type="number" value={maxSpend} onChange={(e) => setMaxSpend(e.target.value)} /></label>
        <label><span>Max € per action <i>(optional)</i></span><input type="number" placeholder="—" value={maxValue} onChange={(e) => setMaxValue(e.target.value)} /></label>
        <label><span>Marketplace</span>
          <select value={scope} onChange={(e) => setScope(e.target.value)}>
            <option value="">All markets</option>
            {conns.map((c) => <option key={c.marketplace} value={c.marketplace}>{marketLabel(c.marketplace)}</option>)}
          </select>
        </label>
      </div>
    </div>
  )

  return (
    <div className="az-bld" style={{ paddingTop: 4 }}>
      <div className="az-bld-head">
        <div className="az-bld-seg" role="tablist" aria-label="Builder mode">
          <button role="tab" aria-selected={mode === 'guided'} className={mode === 'guided' ? 'on' : ''} onClick={() => setMode('guided')}><Wand2 size={14} />Guided</button>
          <button role="tab" aria-selected={mode === 'advanced'} className={mode === 'advanced' ? 'on' : ''} onClick={() => setMode('advanced')}><Settings2 size={14} />Advanced</button>
        </div>
        <span className="az-bld-sub">{mode === 'guided' ? 'Pick a goal, tune a couple of numbers, and ship.' : 'Full control: any trigger, AND/OR conditions, all 26 actions, caps & scope.'}</span>
      </div>

      {/* ── GUIDED ─────────────────────────────────────────────── */}
      {mode === 'guided' && <>
        <div className="az-bld-steps">
          {['Choose a goal', 'Tune it', 'Name & ship'].map((s, i) => <span key={s} className={`st ${step === i + 1 ? 'on' : ''} ${step > i + 1 ? 'done' : ''}`}>{step > i + 1 ? <Check size={12} /> : i + 1}<b>{s}</b></span>)}
        </div>

        {step === 1 && (
          <div className="az-bld-goals">
            {GUIDED_GOALS.map((g) => (
              <button key={g.id} className={`az-bld-goal ${goal === g.id ? 'on' : ''}`} onClick={() => applyGoal(g)}>
                <span className="t">{g.label}</span><span className="d">{g.desc}</span><ArrowRight size={14} className="go" />
              </button>
            ))}
            <button className="az-bld-goal scratch" onClick={() => { setGoal('scratch'); setMode('advanced') }}>
              <span className="t">Start from scratch</span><span className="d">Build it yourself in Advanced — full trigger, conditions &amp; actions.</span><Settings2 size={14} className="go" />
            </button>
          </div>
        )}

        {step === 2 && (
          <div className="az-bld-tune">
            <div className="az-bld-trg"><b>{triggerDef(trigger)?.label}</b> — {triggerDef(trigger)?.hint}</div>
            <div className="az-knobs">
              {groups.flatMap((g, gi) => g.map((c, ri) => c.field ? (
                <label key={`c${gi}-${ri}`} className="az-knob">
                  <span>{fieldDef(c.field)?.label} {opSym(c.op)}</span>
                  <span className="in"><input type="number" step="any" value={c.value} onChange={(e) => setCond(gi, ri, { value: e.target.value })} /><i>{fieldSuffix(fieldDef(c.field)?.unit ?? 'num')}</i></span>
                </label>
              ) : null))}
              {acts.flatMap((a, ai) => (actionDef(a.type)?.params ?? []).filter((p) => p.kind !== 'text').map((p) => (
                <label key={`a${ai}-${p.k}`} className="az-knob">
                  <span>{actionDef(a.type)?.label}: {p.label}</span>
                  {p.kind === 'sel'
                    ? <select value={a.params[p.k] ?? ''} onChange={(e) => setActParam(ai, p.k, e.target.value)}>{p.options?.map((o) => <option key={o.v} value={o.v}>{o.l}</option>)}</select>
                    : <span className="in"><input type="number" step="any" value={a.params[p.k] ?? ''} onChange={(e) => setActParam(ai, p.k, e.target.value)} /><i>{paramSuffix(p.kind)}</i></span>}
                </label>
              )))}
              {groups.every((g) => g.every((c) => !c.field)) && acts.every((a) => (actionDef(a.type)?.params ?? []).filter((p) => p.kind !== 'text').length === 0) && <div className="az-bld-nilknob">This goal needs no numbers — it runs as-is. Continue to name &amp; ship.</div>}
            </div>
            <div className="az-bld-nav"><button className="az-btn" onClick={() => setStep(1)}><ArrowLeft size={14} />Back</button><button className="az-btn dark" onClick={() => setStep(3)}>Next<ArrowRight size={14} /></button><button className="az-link" onClick={() => setMode('advanced')}>Fine-tune in Advanced</button></div>
          </div>
        )}

        {step === 3 && <>
          {capsRow}
          <div className="az-bld-nav"><button className="az-btn" onClick={() => setStep(2)}><ArrowLeft size={14} />Back</button></div>
          {footer}
        </>}
      </>}

      {/* ── ADVANCED ───────────────────────────────────────────── */}
      {mode === 'advanced' && <>
        <div className="az-fp-sec">
          <h4>When (trigger)</h4>
          <select className="az-bld-select" value={trigger} onChange={(e) => changeTrigger(e.target.value)}>
            {TRIGGERS.map((t) => <option key={t.t} value={t.t}>{t.label}</option>)}
          </select>
          <div className="az-bld-hint">{triggerDef(trigger)?.hint}</div>
        </div>

        <div className="az-fp-sec">
          <h4>If (conditions) <span className="az-bld-h4sub">— rows in a group are ALL required (AND); groups are alternatives (OR)</span></h4>
          {groups.map((g, gi) => (
            <div key={gi} className="az-bld-group">
              {gi > 0 && <div className="az-bld-or">OR</div>}
              {g.map((c, ri) => (
                <div className="az-fp-row" key={ri}>
                  <select value={c.field} onChange={(e) => setCond(gi, ri, { field: e.target.value })}>
                    {suggestedFields(trigger).map((f) => <option key={f.f} value={f.f}>{f.label}</option>)}
                  </select>
                  <select value={c.op} onChange={(e) => setCond(gi, ri, { op: e.target.value })}>{OPS.map((o) => <option key={o.v} value={o.v}>{o.l}</option>)}</select>
                  {c.op !== 'exists' && <input type={['in', 'contains'].includes(c.op) ? 'text' : 'number'} step="any" value={c.value} onChange={(e) => setCond(gi, ri, { value: e.target.value })} placeholder={c.op === 'in' ? 'a, b, c' : 'value'} />}
                  <span className="az-bld-unit">{fieldSuffix(fieldDef(c.field)?.unit ?? 'num')}</span>
                  <button className="az-kebab" onClick={() => removeRow(gi, ri)} style={{ color: '#cc1100' }} aria-label="Remove condition"><Trash2 size={14} /></button>
                </div>
              ))}
              <button className="az-link" onClick={() => addRow(gi)}><Plus size={13} /> Add condition (AND)</button>
            </div>
          ))}
          <button className="az-link az-bld-orbtn" onClick={addGroup}><Plus size={13} /> Add OR group</button>
        </div>

        <div className="az-fp-sec">
          <h4>Then (actions)</h4>
          {acts.map((a, ai) => (
            <div className="az-fp-row" key={ai} style={{ flexWrap: 'wrap' }}>
              <select value={a.type} onChange={(e) => setActType(ai, e.target.value)}>
                {ACTION_CATS.map((cat) => <optgroup key={cat} label={cat}>{ACTIONS.filter((x) => x.cat === cat).map((x) => <option key={x.t} value={x.t}>{x.label}</option>)}</optgroup>)}
              </select>
              {paramInput(ai, a)}
              <button className="az-kebab" onClick={() => removeAct(ai)} style={{ color: '#cc1100' }} aria-label="Remove action"><Trash2 size={14} /></button>
            </div>
          ))}
          <button className="az-link" onClick={() => setActs((r) => [...r, { type: 'notify', params: seedParams('notify') }])}><Plus size={13} /> Add action</button>
          <div className="az-bld-hint">{actionDef(acts[acts.length - 1]?.type ?? '')?.desc}</div>
        </div>

        {capsRow}
        {footer}
      </>}
    </div>
  )
}
