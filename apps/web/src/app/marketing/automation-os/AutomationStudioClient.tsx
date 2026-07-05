'use client'

/**
 * UM-series (P6) — Automation studio client.
 *
 * Rule list with enabled/dry-run toggles + execution counts; a compact
 * create form (trigger + single action + caps); per-rule "Test" (forced
 * dry-run preview) and a global "Evaluate now". Lean by design — the full
 * conditions-tree builder can layer on later.
 */

import { useCallback, useState } from 'react'
import { Plus, Play, FlaskConical, Zap, Power, Trash2, X } from 'lucide-react'
import { getBackendUrl } from '@/lib/backend-url'
import { useMarketingEvents } from '@/lib/sync/use-marketing-events'
import { Listbox } from '@/design-system/components/Listbox'
import '@/design-system/styles/tokens.css'
import '@/design-system/styles/components.css'

export interface MarketingRule {
  id: string
  name: string
  description: string | null
  trigger: string
  conditions: unknown
  actions: unknown
  enabled: boolean
  dryRun: boolean
  maxValueCentsEur: number | null
  maxExecutionsPerDay: number | null
  scopeMarketplace: string | null
  executionCount: number
  lastExecutedAt: string | null
  _count?: { executions: number }
}

const TRIGGERS = ['MKT_ACOS_BREACH', 'MKT_UNDERPACING', 'MKT_CRON_TICK']
const ACTIONS = [
  { type: 'mkt_pause_campaign', label: 'Pause campaign' },
  { type: 'mkt_resume_campaign', label: 'Resume campaign' },
  { type: 'mkt_set_budget', label: 'Set budget (€/day)', param: 'budgetEur' },
  { type: 'mkt_adjust_budget', label: 'Adjust budget (%)', param: 'deltaPct' },
]

const api = (p: string, opts?: RequestInit) =>
  fetch(`${getBackendUrl()}/api/marketing/os${p}`, { headers: { 'Content-Type': 'application/json' }, ...opts })

export function AutomationStudioClient({ initialRules }: { initialRules: MarketingRule[] }) {
  const [rules, setRules] = useState(initialRules)
  const [creating, setCreating] = useState(false)
  const [testResult, setTestResult] = useState<{ id: string; text: string } | null>(null)
  const [evalResult, setEvalResult] = useState<string | null>(null)
  const [form, setForm] = useState({ name: '', trigger: 'MKT_ACOS_BREACH', action: 'mkt_pause_campaign', actionParam: '', maxValueEur: '', dryRun: true })

  const refetch = useCallback(async () => {
    const res = await api('/rules')
    if (res.ok) setRules((await res.json()).items ?? [])
  }, [])
  useMarketingEvents(useCallback(() => void refetch(), [refetch]), { eventTypes: ['rule.executed'] })

  const createRule = async () => {
    const actionDef = ACTIONS.find((a) => a.type === form.action)!
    const action: Record<string, unknown> = { type: form.action }
    if (actionDef.param === 'budgetEur' && form.actionParam) action.budgetCents = Math.round(parseFloat(form.actionParam) * 100)
    if (actionDef.param === 'deltaPct' && form.actionParam) action.deltaPct = parseFloat(form.actionParam)
    await api('/rules', {
      method: 'POST',
      body: JSON.stringify({
        name: form.name,
        trigger: form.trigger,
        actions: [action],
        conditions: [],
        enabled: true,
        dryRun: form.dryRun,
        maxValueCentsEur: form.maxValueEur ? Math.round(parseFloat(form.maxValueEur) * 100) : null,
      }),
    })
    setCreating(false)
    setForm({ name: '', trigger: 'MKT_ACOS_BREACH', action: 'mkt_pause_campaign', actionParam: '', maxValueEur: '', dryRun: true })
    void refetch()
  }

  const patch = async (id: string, body: Record<string, unknown>) => {
    await api(`/rules/${id}`, { method: 'PATCH', body: JSON.stringify(body) })
    void refetch()
  }
  const del = async (id: string) => { await api(`/rules/${id}`, { method: 'DELETE' }); void refetch() }
  const test = async (id: string) => {
    const res = await api(`/rules/${id}/run`, { method: 'POST' })
    const j = await res.json()
    setTestResult({ id, text: JSON.stringify(j.result ?? j, null, 1) })
  }
  const evaluateNow = async () => {
    const res = await api('/rules/evaluate-now', { method: 'POST' })
    const j = await res.json()
    setEvalResult(`evals=${j.totalEvaluations ?? '?'} matches=${j.totalMatches ?? '?'} (acos=${j.acosBreachContexts ?? 0}, underpace=${j.underpacingContexts ?? 0})`)
    void refetch()
  }

  return (
    <div className="p-4 sm:p-6 max-w-[1200px] mx-auto">
      <header className="flex flex-wrap items-center gap-3 mb-4">
        <div className="flex items-center gap-2">
          <Zap size={20} className="text-violet-500" />
          <h1 className="text-xl font-semibold text-slate-900 dark:text-slate-100">Automation studio</h1>
        </div>
        <p className="w-full sm:w-auto text-sm text-slate-500 dark:text-slate-400">
          Cross-channel campaign rules. Rules ship in dry-run — graduate to live explicitly; every money action is bounded by caps + the channel write gate (Amazon sandbox until cutover).
        </p>
        <div className="ml-auto flex gap-2">
          <button onClick={evaluateNow} className="inline-flex items-center gap-1 px-3 py-1.5 text-sm rounded-md border border-default dark:border-slate-700 hover:bg-slate-50 dark:hover:bg-slate-800"><Play size={14} /> Evaluate now</button>
          <button onClick={() => setCreating(true)} className="inline-flex items-center gap-1 px-3 py-1.5 text-sm rounded-md bg-violet-600 text-white hover:bg-violet-700"><Plus size={14} /> New rule</button>
        </div>
      </header>

      {evalResult && <div className="mb-3 text-xs text-slate-500 bg-slate-50 dark:bg-slate-900 rounded px-3 py-2">Evaluator: {evalResult}</div>}

      <div className="rounded-lg border border-default dark:border-slate-800 overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-slate-50 dark:bg-slate-900/60 text-slate-500 text-xs uppercase">
            <tr>
              <th className="text-left font-medium px-3 py-2">Rule</th>
              <th className="text-left font-medium px-3 py-2">Trigger</th>
              <th className="text-left font-medium px-3 py-2">Action</th>
              <th className="text-center font-medium px-3 py-2">Mode</th>
              <th className="text-right font-medium px-3 py-2">Runs</th>
              <th className="text-center font-medium px-3 py-2">Controls</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
            {rules.length === 0 && <tr><td colSpan={6} className="px-3 py-10 text-center text-tertiary">No rules yet. Create one to automate pauses, budget cuts, or boosts.</td></tr>}
            {rules.map((r) => {
              const action = Array.isArray(r.actions) ? (r.actions[0] as { type?: string }) : null
              return (
                <tr key={r.id} className="hover:bg-slate-50 dark:hover:bg-slate-900/40 align-top">
                  <td className="px-3 py-2"><div className="font-medium text-slate-800 dark:text-slate-100">{r.name}</div>{r.maxValueCentsEur ? <div className="text-xs text-tertiary">cap €{(r.maxValueCentsEur / 100).toFixed(0)}</div> : null}</td>
                  <td className="px-3 py-2 text-xs text-slate-600 dark:text-slate-300">{r.trigger}</td>
                  <td className="px-3 py-2 text-xs text-slate-600 dark:text-slate-300">{action?.type ?? '—'}</td>
                  <td className="px-3 py-2 text-center">
                    <button onClick={() => patch(r.id, { dryRun: !r.dryRun })} className={`px-1.5 py-0.5 rounded text-xs font-medium ${r.dryRun ? 'bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300' : 'bg-rose-100 text-rose-700 dark:bg-rose-950/50 dark:text-rose-300'}`} title="Toggle dry-run / live">
                      {r.dryRun ? 'dry-run' : 'LIVE'}
                    </button>
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums text-slate-500">{r._count?.executions ?? r.executionCount ?? 0}</td>
                  <td className="px-3 py-2">
                    <div className="flex items-center justify-center gap-1">
                      <button onClick={() => patch(r.id, { enabled: !r.enabled })} title={r.enabled ? 'Disable' : 'Enable'} className={`p-1 rounded hover:bg-slate-100 dark:hover:bg-slate-800 ${r.enabled ? 'text-emerald-600' : 'text-tertiary'}`}><Power size={14} /></button>
                      <button onClick={() => test(r.id)} title="Test (dry-run)" className="p-1 rounded hover:bg-slate-100 dark:hover:bg-slate-800 text-blue-600"><FlaskConical size={14} /></button>
                      <button onClick={() => del(r.id)} title="Delete" className="p-1 rounded hover:bg-slate-100 dark:hover:bg-slate-800 text-rose-500"><Trash2 size={14} /></button>
                    </div>
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>

      {testResult && (
        <div className="mt-3 rounded-lg border border-blue-200 dark:border-blue-900 bg-blue-50/50 dark:bg-blue-950/20 p-3">
          <div className="flex items-center justify-between mb-1"><span className="text-xs font-medium text-blue-700 dark:text-blue-300">Dry-run result</span><button onClick={() => setTestResult(null)}><X size={14} /></button></div>
          <pre className="text-[11px] text-slate-600 dark:text-slate-300 overflow-x-auto whitespace-pre-wrap">{testResult.text}</pre>
        </div>
      )}

      {creating && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={() => setCreating(false)}>
          <div className="bg-white dark:bg-slate-900 rounded-lg shadow-xl w-full max-w-md p-4" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-3"><h2 className="font-semibold">New automation rule</h2><button onClick={() => setCreating(false)}><X size={16} /></button></div>
            <div className="space-y-3">
              <input autoFocus placeholder="Rule name (e.g. Pause high-ACOS DE)" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} className="w-full px-2 py-1.5 text-sm rounded border border-default dark:border-slate-700 bg-white dark:bg-slate-950" />
              <label className="block text-xs text-slate-500">When (trigger)
                <Listbox
                  options={TRIGGERS.map((t) => ({ value: t, label: t }))}
                  value={form.trigger}
                  onChange={(v) => setForm({ ...form, trigger: v })}
                  ariaLabel="Trigger"
                  className="w-full mt-0.5"
                />
              </label>
              <label className="block text-xs text-slate-500">Do (action)
                <Listbox
                  options={ACTIONS.map((a) => ({ value: a.type, label: a.label }))}
                  value={form.action}
                  onChange={(v) => setForm({ ...form, action: v, actionParam: '' })}
                  ariaLabel="Action"
                  className="w-full mt-0.5"
                />
              </label>
              {ACTIONS.find((a) => a.type === form.action)?.param && (
                <input placeholder={ACTIONS.find((a) => a.type === form.action)?.param === 'deltaPct' ? 'e.g. -20 (cut 20%)' : 'e.g. 25.00 (€/day)'} value={form.actionParam} onChange={(e) => setForm({ ...form, actionParam: e.target.value })} className="w-full px-2 py-1.5 text-sm rounded border border-default dark:border-slate-700 bg-white dark:bg-slate-950" />
              )}
              <div className="flex gap-2 items-center">
                <input placeholder="Per-exec cap € (optional)" value={form.maxValueEur} onChange={(e) => setForm({ ...form, maxValueEur: e.target.value })} className="flex-1 px-2 py-1.5 text-sm rounded border border-default dark:border-slate-700 bg-white dark:bg-slate-950" />
                <label className="flex items-center gap-1 text-xs text-slate-500"><input type="checkbox" checked={form.dryRun} onChange={(e) => setForm({ ...form, dryRun: e.target.checked })} /> dry-run</label>
              </div>
            </div>
            <div className="flex justify-end gap-2 mt-4">
              <button onClick={() => setCreating(false)} className="px-3 py-1.5 text-sm rounded border border-default dark:border-slate-700">Cancel</button>
              <button onClick={createRule} disabled={!form.name} className="px-3 py-1.5 text-sm rounded bg-violet-600 text-white hover:bg-violet-700 disabled:opacity-50">Create</button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
