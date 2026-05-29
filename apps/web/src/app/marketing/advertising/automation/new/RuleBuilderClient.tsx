'use client'

/** AX3.8 — Visual rule builder: trigger → conditions (AND) → actions →
 *  guardrails. Produces the AutomationRule engine contract and POSTs it
 *  (starts disabled + dry-run; operator enables on the detail page). */

import { useState, useEffect, useCallback } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import Link from 'next/link'
import { ChevronLeft, Plus, Trash2 } from 'lucide-react'
import { getBackendUrl } from '@/lib/backend-url'
import { TRIGGERS, CONDITION_FIELDS, OPS, ACTION_TYPES, TEMPLATES } from '../../_shared/rule-catalog'

interface Cond { field: string; op: string; value: string }
interface Act { type: string; params: Record<string, string> }

function defaultParams(type: string): Record<string, string> {
  const at = ACTION_TYPES.find((a) => a.type === type)
  const p: Record<string, string> = {}
  for (const par of at?.params ?? []) p[par.key] = String(par.default ?? '')
  return p
}

export function RuleBuilderClient() {
  const router = useRouter()
  const search = useSearchParams()
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [trigger, setTrigger] = useState(TRIGGERS[0].key)
  const [conds, setConds] = useState<Cond[]>([{ field: CONDITION_FIELDS[0].field, op: 'gte', value: '' }])
  const [acts, setActs] = useState<Act[]>([{ type: 'bid_down', params: defaultParams('bid_down') }])
  const [maxExec, setMaxExec] = useState('10')
  const [maxDailySpendEur, setMaxDailySpendEur] = useState('100')
  const [scope, setScope] = useState('')
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState('')

  // Prefill from a library template (?template=key).
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

  const setCond = (i: number, p: Partial<Cond>) => setConds((cs) => cs.map((c, j) => (j === i ? { ...c, ...p } : c)))
  const setAct = (i: number, type: string) => setActs((as) => as.map((a, j) => (j === i ? { type, params: defaultParams(type) } : a)))
  const setActParam = (i: number, k: string, v: string) => setActs((as) => as.map((a, j) => (j === i ? { ...a, params: { ...a.params, [k]: v } } : a)))

  const submit = async () => {
    if (!name.trim()) { setMsg('Name required'); return }
    setBusy(true); setMsg('')
    try {
      const conditions = conds.filter((c) => c.value !== '').map((c) => ({ field: c.field, op: c.op, value: Number(c.value) }))
      const actions = acts.map((a) => { const out: Record<string, unknown> = { type: a.type }; for (const [k, v] of Object.entries(a.params)) out[k] = isNaN(Number(v)) || v === '' ? v : Number(v); return out })
      const r = await fetch(`${getBackendUrl()}/api/advertising/automation-rules`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: name.trim(), description: description.trim() || undefined, trigger, conditions, actions, maxExecutionsPerDay: Number(maxExec) || 10, maxDailyAdSpendCentsEur: Math.round((parseFloat(maxDailySpendEur) || 100) * 100), scopeMarketplace: scope || undefined }) }).then((x) => x.json())
      if (r?.error || !r?.rule?.id) throw new Error(r?.error || 'create failed')
      router.push(`/marketing/advertising/automation/${r.rule.id}`)
    } catch (e) { setMsg((e as Error).message); setBusy(false) }
  }

  return (
    <div className="max-w-[820px]">
      <Link href="/marketing/advertising/automation" className="inline-flex items-center gap-1 text-sm text-slate-500 hover:text-slate-700 mb-2"><ChevronLeft size={14} /> Automation</Link>
      <h1 className="text-xl font-semibold text-slate-900 dark:text-slate-100 mb-1">New rule</h1>
      <p className="text-sm text-slate-500 mb-4">Compose a When → If → Then rule. It saves <b>disabled + dry-run</b>; enable it on the next screen. <Link href="/marketing/advertising/automation/library" className="text-blue-600 hover:underline">Start from a template →</Link></p>

      <div className="space-y-4">
        <div className="flex gap-2">
          <label className="flex-1 text-xs text-slate-500">Rule name<input value={name} onChange={(e) => setName(e.target.value)} className="w-full mt-0.5 px-2 py-1.5 text-sm rounded border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950" /></label>
          <label className="flex-[2] text-xs text-slate-500">Description<input value={description} onChange={(e) => setDescription(e.target.value)} className="w-full mt-0.5 px-2 py-1.5 text-sm rounded border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950" /></label>
        </div>

        {/* When */}
        <div className="rounded-lg border border-slate-200 dark:border-slate-800 p-3">
          <div className="text-xs font-semibold text-slate-600 dark:text-slate-300 mb-2">WHEN (trigger)</div>
          <select value={trigger} onChange={(e) => setTrigger(e.target.value)} className="px-2 py-1.5 text-sm rounded border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950 w-full">
            {TRIGGERS.map((t) => <option key={t.key} value={t.key}>{t.label} — {t.blurb}</option>)}
          </select>
        </div>

        {/* If */}
        <div className="rounded-lg border border-slate-200 dark:border-slate-800 p-3">
          <div className="text-xs font-semibold text-slate-600 dark:text-slate-300 mb-2">IF (all conditions, AND)</div>
          <div className="space-y-2">
            {conds.map((c, i) => {
              const cf = CONDITION_FIELDS.find((f) => f.field === c.field)
              return (
                <div key={i} className="flex items-center gap-2">
                  <select value={c.field} onChange={(e) => setCond(i, { field: e.target.value })} className="px-2 py-1 text-sm rounded border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950 flex-1">{CONDITION_FIELDS.map((f) => <option key={f.field} value={f.field}>{f.label}</option>)}</select>
                  <select value={c.op} onChange={(e) => setCond(i, { op: e.target.value })} className="px-2 py-1 text-sm rounded border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950 w-16">{OPS.map((o) => <option key={o.op} value={o.op}>{o.label}</option>)}</select>
                  <input value={c.value} onChange={(e) => setCond(i, { value: e.target.value })} placeholder={cf?.hint} className="px-2 py-1 text-sm rounded border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950 w-32" />
                  {conds.length > 1 && <button onClick={() => setConds((cs) => cs.filter((_, j) => j !== i))} className="text-slate-400 hover:text-rose-600"><Trash2 size={14} /></button>}
                </div>
              )
            })}
          </div>
          <button onClick={() => setConds((cs) => [...cs, { field: CONDITION_FIELDS[0].field, op: 'gte', value: '' }])} className="mt-2 inline-flex items-center gap-1 text-xs text-blue-600 hover:underline"><Plus size={12} /> Add condition</button>
        </div>

        {/* Then */}
        <div className="rounded-lg border border-slate-200 dark:border-slate-800 p-3">
          <div className="text-xs font-semibold text-slate-600 dark:text-slate-300 mb-2">THEN (actions)</div>
          <div className="space-y-3">
            {acts.map((a, i) => {
              const at = ACTION_TYPES.find((x) => x.type === a.type)
              return (
                <div key={i} className="rounded-md border border-slate-100 dark:border-slate-800 p-2">
                  <div className="flex items-center gap-2 mb-1">
                    <select value={a.type} onChange={(e) => setAct(i, e.target.value)} className="px-2 py-1 text-sm rounded border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950 flex-1">{ACTION_TYPES.map((x) => <option key={x.type} value={x.type}>{x.label}</option>)}</select>
                    {acts.length > 1 && <button onClick={() => setActs((as) => as.filter((_, j) => j !== i))} className="text-slate-400 hover:text-rose-600"><Trash2 size={14} /></button>}
                  </div>
                  <div className="text-[11px] text-slate-400 mb-1">{at?.blurb}</div>
                  {(at?.params.length ?? 0) > 0 && (
                    <div className="flex flex-wrap gap-2">
                      {at!.params.map((p) => (
                        <label key={p.key} className="flex flex-col text-[11px] text-slate-500">{p.label}
                          {p.type === 'select'
                            ? <select value={a.params[p.key] ?? ''} onChange={(e) => setActParam(i, p.key, e.target.value)} className="mt-0.5 px-2 py-1 text-sm rounded border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950">{p.options!.map((o) => <option key={o} value={o}>{o}</option>)}</select>
                            : <input type={p.type === 'number' ? 'number' : 'text'} value={a.params[p.key] ?? ''} onChange={(e) => setActParam(i, p.key, e.target.value)} className="mt-0.5 px-2 py-1 text-sm rounded border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950 w-28" />}
                        </label>
                      ))}
                    </div>
                  )}
                </div>
              )
            })}
          </div>
          <button onClick={() => setActs((as) => [...as, { type: 'notify', params: defaultParams('notify') }])} className="mt-2 inline-flex items-center gap-1 text-xs text-blue-600 hover:underline"><Plus size={12} /> Add action</button>
        </div>

        {/* Guardrails */}
        <div className="rounded-lg border border-slate-200 dark:border-slate-800 p-3 flex flex-wrap items-end gap-3">
          <div className="text-xs font-semibold text-slate-600 dark:text-slate-300 w-full">GUARDRAILS</div>
          <label className="flex flex-col text-[11px] text-slate-500">Max executions / day<input type="number" value={maxExec} onChange={(e) => setMaxExec(e.target.value)} className="mt-0.5 px-2 py-1 text-sm rounded border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950 w-28" /></label>
          <label className="flex flex-col text-[11px] text-slate-500">Max daily ad-spend (€)<input type="number" value={maxDailySpendEur} onChange={(e) => setMaxDailySpendEur(e.target.value)} className="mt-0.5 px-2 py-1 text-sm rounded border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950 w-28" /></label>
          <label className="flex flex-col text-[11px] text-slate-500">Marketplace scope<select value={scope} onChange={(e) => setScope(e.target.value)} className="mt-0.5 px-2 py-1 text-sm rounded border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950"><option value="">All</option>{['IT', 'DE', 'FR', 'ES', 'NL', 'BE', 'SE', 'PL', 'IE', 'UK'].map((m) => <option key={m}>{m}</option>)}</select></label>
        </div>

        <div className="flex items-center gap-3">
          <button onClick={submit} disabled={busy || !name.trim()} className="px-4 py-2 text-sm rounded-md bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50">{busy ? 'Creating…' : 'Create rule (dry-run)'}</button>
          {msg && <span className="text-sm text-rose-600">{msg}</span>}
        </div>
      </div>
    </div>
  )
}
