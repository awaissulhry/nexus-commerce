'use client'

/**
 * AU.7 — Visual rule builder: WHEN → IF → THEN → Guardrails.
 * Supports all 11 triggers, 24+ actions, trigger-aware condition fields.
 * All rules save disabled + dry-run — zero Amazon writes until operator enables.
 */

import { useState, useEffect, useCallback, useMemo } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import Link from 'next/link'
import { ChevronLeft, Plus, Trash2, Info } from 'lucide-react'
import { getBackendUrl } from '@/lib/backend-url'
import { TRIGGERS, CONDITION_FIELDS, OPS, ACTION_TYPES, TEMPLATES } from '../../_shared/rule-catalog'

interface Cond { field: string; op: string; value: string }
interface Act { type: string; params: Record<string, string> }

// Condition fields relevant per trigger — show all for SCHEDULE; filter for event triggers
const TRIGGER_FIELDS: Record<string, string[]> = {
  SCHEDULE: ['campaign.acos', 'budget.monthlySpendCents', 'campaign.dailyBudget'],
  AD_TARGET_UNDERPERFORMING: ['adTarget.spendCents', 'adTarget.salesCents', 'adTarget.bidCents', 'adTarget.clicks', 'adTarget.ordersCount', 'campaign.acos'],
  CAC_SPIKE: ['campaign.acos', 'adTarget.spendCents', 'campaign.dailyBudget'],
  AD_SPEND_PROFITABILITY_BREACH: ['profit.netCents', 'campaign.acos'],
  FBA_AGE_THRESHOLD_REACHED: ['fbaAge.daysToLtsThreshold'],
  CAMPAIGN_PERFORMANCE_BUDGET: ['campaign.acos', 'campaign.roas', 'campaign.budgetUtilization', 'campaign.dailyBudget'],
  KEYWORD_ZERO_IMPRESSIONS: ['adTarget.spendCents', 'adTarget.impressions'],
  KEYWORD_LOW_CTR: ['adTarget.impressions', 'adTarget.ctr', 'adTarget.spendCents'],
  CVR_DROP: ['adTarget.currentCvr', 'adTarget.previousCvr', 'adTarget.clicks'],
  KEYWORD_WASTED_SPEND: ['adTarget.spendCents', 'adTarget.clicks'],
  SEARCH_TERM_CONVERTING: ['searchTerm.orders', 'searchTerm.spendCents'],
}

function defaultParams(type: string): Record<string, string> {
  const at = ACTION_TYPES.find((a) => a.type === type)
  const p: Record<string, string> = {}
  for (const par of at?.params ?? []) p[par.key] = String(par.default ?? '')
  return p
}

const cls = 'px-2 py-1.5 text-sm rounded border border-default dark:border-slate-700 bg-white dark:bg-slate-950 focus:ring-1 focus:ring-blue-500 outline-none'

export function RuleBuilderClient() {
  const router = useRouter()
  const search = useSearchParams()
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [trigger, setTrigger] = useState(TRIGGERS[0].key)
  const [conds, setConds] = useState<Cond[]>([])
  const [acts, setActs] = useState<Act[]>([{ type: 'notify', params: defaultParams('notify') }])
  const [maxExec, setMaxExec] = useState('10')
  const [maxDailySpendEur, setMaxDailySpendEur] = useState('')
  const [scope, setScope] = useState('')
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState('')

  const relevantFields = useMemo(() => {
    const keys = TRIGGER_FIELDS[trigger]
    if (!keys) return CONDITION_FIELDS
    return CONDITION_FIELDS.filter((f) => keys.includes(f.field))
  }, [trigger])

  const applyTemplate = useCallback((key: string) => {
    const t = TEMPLATES.find((x) => x.key === key)
    if (!t) return
    setName(t.name); setDescription(t.description); setTrigger(t.trigger)
    setConds(t.conditions.map((c) => ({ field: c.field, op: c.op, value: String(c.value) })))
    setActs(t.actions.map((a) => { const { type, ...rest } = a as { type: string } & Record<string, unknown>; const params = defaultParams(type); for (const k of Object.keys(rest)) params[k] = String(rest[k]); return { type, params } }))
    if (t.maxExecutionsPerDay) setMaxExec(String(t.maxExecutionsPerDay))
    if (t.maxDailyAdSpendCentsEur) setMaxDailySpendEur(String(t.maxDailyAdSpendCentsEur / 100))
  }, [])
  useEffect(() => { const k = search.get('template'); if (k) applyTemplate(k) }, [search, applyTemplate])

  const isSchedule = trigger === 'SCHEDULE'
  const setCond = (i: number, p: Partial<Cond>) => setConds((cs) => cs.map((c, j) => j === i ? { ...c, ...p } : c))
  const setAct = (i: number, t: string) => setActs((as) => as.map((a, j) => j === i ? { type: t, params: defaultParams(t) } : a))
  const setActParam = (i: number, k: string, v: string) => setActs((as) => as.map((a, j) => j === i ? { ...a, params: { ...a.params, [k]: v } } : a))

  const submit = async () => {
    if (!name.trim()) { setMsg('Name required'); return }
    setBusy(true); setMsg('')
    try {
      const conditions = conds.filter((c) => c.value !== '').map((c) => ({ field: c.field, op: c.op, value: Number(c.value) }))
      const actions = acts.map((a) => { const out: Record<string, unknown> = { type: a.type }; for (const [k, v] of Object.entries(a.params)) out[k] = isNaN(Number(v)) || v === '' ? v : Number(v); return out })
      const r = await fetch(`${getBackendUrl()}/api/advertising/automation-rules`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: name.trim(), description: description.trim() || undefined, trigger, conditions, actions, maxExecutionsPerDay: Number(maxExec) || 10, maxDailyAdSpendCentsEur: maxDailySpendEur ? Math.round(parseFloat(maxDailySpendEur) * 100) : null, scopeMarketplace: scope || undefined }),
      }).then((x) => x.json())
      if (r?.error || !r?.rule?.id) throw new Error(r?.error || 'create failed')
      router.push(`/marketing/advertising/automation/${r.rule.id}`)
    } catch (e) { setMsg((e as Error).message); setBusy(false) }
  }

  const selectedTrigger = TRIGGERS.find((t) => t.key === trigger)

  return (
    <div className="max-w-[820px]">
      <Link href="/marketing/advertising/automation" className="inline-flex items-center gap-1 text-sm text-slate-500 hover:text-slate-700 mb-2"><ChevronLeft className="h-3.5 w-3.5" /> Automation</Link>
      <h1 className="text-xl font-semibold text-slate-900 dark:text-slate-100 mb-0.5">New automation rule</h1>
      <p className="text-sm text-slate-500 mb-4">Saves <strong>disabled + dry-run</strong> — enable it on the next screen to go live. <Link href="/marketing/advertising/automation/library" className="text-blue-600 hover:underline">Start from a template →</Link></p>

      <div className="space-y-3">
        {/* Name + description */}
        <div className="flex gap-2">
          <label className="flex-1 text-xs text-slate-500">Rule name *
            <input value={name} onChange={(e) => setName(e.target.value)} placeholder="My automation rule" className={`${cls} w-full mt-0.5`} />
          </label>
          <label className="flex-[2] text-xs text-slate-500">Description
            <input value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Optional — shown in the rule list" className={`${cls} w-full mt-0.5`} />
          </label>
        </div>

        {/* WHEN */}
        <div className="rounded-lg border border-default dark:border-slate-800 p-3">
          <div className="text-xs font-semibold text-slate-600 dark:text-slate-300 mb-2 flex items-center gap-1.5">
            <span className="h-1.5 w-1.5 rounded-full bg-blue-500 inline-block" />WHEN
          </div>
          <select value={trigger} onChange={(e) => { setTrigger(e.target.value); setConds([]) }} className={`${cls} w-full`}>
            {TRIGGERS.map((t) => <option key={t.key} value={t.key}>{t.label}</option>)}
          </select>
          {selectedTrigger && <p className="text-[11px] text-tertiary mt-1">{selectedTrigger.blurb}</p>}
        </div>

        {/* IF */}
        <div className="rounded-lg border border-default dark:border-slate-800 p-3">
          <div className="text-xs font-semibold text-slate-600 dark:text-slate-300 mb-2 flex items-center gap-1.5">
            <span className="h-1.5 w-1.5 rounded-full bg-amber-400 inline-block" />
            IF <span className="font-normal text-tertiary ml-1">(all conditions must match — AND logic)</span>
          </div>
          {isSchedule && conds.length === 0 && (
            <div className="flex items-start gap-1.5 text-[11px] text-tertiary mb-2">
              <Info className="h-3 w-3 mt-0.5 shrink-0" />
              Scheduled rules fire every 15 min regardless — add a condition like <code className="px-1 rounded bg-slate-100 dark:bg-slate-800">budget.monthlySpendCents ≥ 200000</code> to gate them.
            </div>
          )}
          <div className="space-y-2">
            {conds.map((c, i) => {
              const cf = CONDITION_FIELDS.find((f) => f.field === c.field) ?? relevantFields[0]
              return (
                <div key={i} className="flex items-center gap-1.5 flex-wrap">
                  <select value={c.field} onChange={(e) => setCond(i, { field: e.target.value })} className={`${cls} flex-1 min-w-[160px]`}>
                    {relevantFields.map((f) => <option key={f.field} value={f.field}>{f.label}</option>)}
                  </select>
                  <select value={c.op} onChange={(e) => setCond(i, { op: e.target.value })} className={`${cls} w-14`}>{OPS.map((o) => <option key={o.op} value={o.op}>{o.label}</option>)}</select>
                  <input value={c.value} onChange={(e) => setCond(i, { value: e.target.value })} placeholder={cf?.hint ?? 'value'} className={`${cls} w-28`} />
                  <button onClick={() => setConds((cs) => cs.filter((_, j) => j !== i))} className="text-slate-300 hover:text-rose-500"><Trash2 className="h-3.5 w-3.5" /></button>
                </div>
              )
            })}
          </div>
          <button onClick={() => setConds((cs) => [...cs, { field: relevantFields[0]?.field ?? CONDITION_FIELDS[0].field, op: 'gte', value: '' }])} className="mt-2 inline-flex items-center gap-1 text-xs text-blue-600 hover:underline"><Plus className="h-3 w-3" /> Add condition</button>
        </div>

        {/* THEN */}
        <div className="rounded-lg border border-default dark:border-slate-800 p-3">
          <div className="text-xs font-semibold text-slate-600 dark:text-slate-300 mb-2 flex items-center gap-1.5">
            <span className="h-1.5 w-1.5 rounded-full bg-emerald-500 inline-block" />THEN
          </div>
          <div className="space-y-3">
            {acts.map((a, i) => {
              const at = ACTION_TYPES.find((x) => x.type === a.type)
              return (
                <div key={i} className="rounded-md border border-subtle dark:border-slate-800 bg-slate-50/50 dark:bg-slate-900/50 p-2.5">
                  <div className="flex items-center gap-2 mb-1">
                    <select value={a.type} onChange={(e) => setAct(i, e.target.value)} className={`${cls} flex-1`}>
                      {ACTION_TYPES.map((x) => <option key={x.type} value={x.type}>{x.label}</option>)}
                    </select>
                    {acts.length > 1 && <button onClick={() => setActs((as) => as.filter((_, j) => j !== i))} className="text-slate-300 hover:text-rose-500"><Trash2 className="h-3.5 w-3.5" /></button>}
                  </div>
                  {at?.blurb && <div className="text-[11px] text-tertiary mb-1.5">{at.blurb}</div>}
                  {(at?.params.length ?? 0) > 0 && (
                    <div className="flex flex-wrap gap-2">
                      {at!.params.map((p) => (
                        <label key={p.key} className="flex flex-col text-[11px] text-slate-500">{p.label}
                          {p.type === 'select'
                            ? <select value={a.params[p.key] ?? ''} onChange={(e) => setActParam(i, p.key, e.target.value)} className={`${cls} mt-0.5`}>{p.options!.map((o) => <option key={o}>{o}</option>)}</select>
                            : <input type={p.type === 'number' ? 'number' : 'text'} value={a.params[p.key] ?? ''} onChange={(e) => setActParam(i, p.key, e.target.value)} placeholder={p.hint} className={`${cls} w-28 mt-0.5`} />}
                        </label>
                      ))}
                    </div>
                  )}
                </div>
              )
            })}
          </div>
          <button onClick={() => setActs((as) => [...as, { type: 'notify', params: defaultParams('notify') }])} className="mt-2 inline-flex items-center gap-1 text-xs text-blue-600 hover:underline"><Plus className="h-3 w-3" /> Add action</button>
        </div>

        {/* Guardrails */}
        <div className="rounded-lg border border-default dark:border-slate-800 p-3">
          <div className="text-xs font-semibold text-slate-600 dark:text-slate-300 mb-2 flex items-center gap-1.5">
            <span className="h-1.5 w-1.5 rounded-full bg-rose-400 inline-block" />GUARDRAILS
          </div>
          <div className="flex flex-wrap items-end gap-3">
            <label className="flex flex-col text-[11px] text-slate-500">Max executions / day
              <input type="number" value={maxExec} onChange={(e) => setMaxExec(e.target.value)} className={`${cls} w-28 mt-0.5`} />
            </label>
            <label className="flex flex-col text-[11px] text-slate-500">Max daily ad-spend (€, optional)
              <input type="number" value={maxDailySpendEur} onChange={(e) => setMaxDailySpendEur(e.target.value)} placeholder="no limit" className={`${cls} w-28 mt-0.5`} />
            </label>
            <label className="flex flex-col text-[11px] text-slate-500">Marketplace scope
              <select value={scope} onChange={(e) => setScope(e.target.value)} className={`${cls} mt-0.5`}>
                <option value="">All marketplaces</option>
                {['IT', 'DE', 'FR', 'ES', 'NL', 'BE', 'SE', 'PL', 'IE', 'UK'].map((m) => <option key={m}>{m}</option>)}
              </select>
            </label>
          </div>
        </div>

        <div className="flex items-center gap-3">
          <button onClick={submit} disabled={busy || !name.trim()} className="px-4 py-2 text-sm rounded-md bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50">
            {busy ? 'Creating…' : 'Create rule (dry-run)'}
          </button>
          <span className="text-xs text-tertiary">Saves disabled + dry-run — you enable it on the next screen</span>
          {msg && <span className="text-sm text-rose-600">{msg}</span>}
        </div>
      </div>
    </div>
  )
}
