'use client'

/**
 * OL.D.4 — Listing automation rules UI.
 *
 * List + builder + run history for domain='listings' AutomationRule.
 * Talks to /api/listing-automation-rules (CRUD + dry-run + executions).
 * Trigger → conditions (flat AND list) → actions, read top-to-bottom.
 * Rules ship dry-run by default; the builder makes that explicit.
 */

import { useCallback, useEffect, useState } from 'react'
import '@/design-system/styles/tokens.css'
import '@/design-system/styles/components.css'
import {
  AlertTriangle, CheckCircle2, History as HistoryIcon, Loader2,
  Pause, Play, Plus, Save, TestTube, Trash2, X,
} from 'lucide-react'
import { Listbox } from '@/design-system/components/Listbox'
import { Button } from '@/components/ui/Button'
import { Badge } from '@/components/ui/Badge'
import { useConfirm } from '@/components/ui/ConfirmProvider'
import { getBackendUrl } from '@/lib/backend-url'
import { cn } from '@/lib/utils'

const TRIGGERS = [
  { id: 'price_diverged', label: 'Price diverged across markets', help: 'Fires when a product’s active EUR listings spread beyond your threshold. Context: price.min / price.max / price.spreadPct.' },
  { id: 'inventory_low', label: 'Inventory low', help: 'Fires on the lowest published quantity across a product’s active listings. Context: inventory.available.' },
  { id: 'listing_health_low', label: 'Listing health low', help: 'Fires when a product’s marketplace-aware health drops below a threshold. Context: health.score. (Coming in D.5.)' },
  { id: 'master_content_changed', label: 'Master content changed', help: 'Fires when the master title/description diverges from the channels. (Coming in D.6.)' },
] as const

const ACTION_TYPES = [
  { id: 'sync_price_to_marketplaces', label: 'Sync price to marketplaces', help: 'Enqueue a price push to eligible listings (currency-guarded, 5-min grace).' },
  { id: 'sync_inventory_to_marketplaces', label: 'Sync inventory to marketplaces', help: 'Enqueue a quantity push to eligible listings.' },
  { id: 'cascade_translate_content', label: 'Cascade & translate content', help: 'Translate master title/description into each target market’s language (glossary-aware) and enqueue behind the 5-min grace window.' },
  { id: 'notify', label: 'Notify operator', help: 'Log + (future) in-app notification — no marketplace writes.' },
  { id: 'log_only', label: 'Log only', help: 'Audit-only — record an execution row but take no action.' },
] as const

const OPS = ['eq', 'ne', 'lt', 'lte', 'gt', 'gte', 'contains', 'exists'] as const

interface Cond { field: string; op: string; value?: string }
interface Act { type: string; referencePrice?: string; onlySameCurrency?: boolean; quantity?: string; channels?: string; marketplaces?: string; message?: string; sourceLanguage?: string }
interface Rule {
  id: string; name: string; description: string | null; domain: string; trigger: string
  conditions: unknown; actions: unknown[]; enabled: boolean; dryRun: boolean
  maxExecutionsPerDay: number | null; maxValueCentsEur: number | null
  evaluationCount?: number; matchCount?: number; executionCount?: number
}
interface Execution {
  id: string; status: string; dryRun: boolean; startedAt: string; durationMs: number | null
  errorMessage: string | null; actionResults: unknown
}

interface Draft {
  id?: string; name: string; trigger: string; conditions: Cond[]; actions: Act[]
  enabled: boolean; dryRun: boolean; maxExecutionsPerDay: string; maxValueCentsEur: string
}

function emptyDraft(): Draft {
  return {
    name: '', trigger: 'price_diverged',
    conditions: [{ field: 'price.spreadPct', op: 'gt', value: '10' }],
    actions: [{ type: 'sync_price_to_marketplaces', referencePrice: 'master', onlySameCurrency: true }],
    enabled: false, dryRun: true, maxExecutionsPerDay: '50', maxValueCentsEur: '',
  }
}

// Map a stored rule → editable draft.
function toDraft(r: Rule): Draft {
  const conds = Array.isArray(r.conditions) ? (r.conditions as Cond[]) : []
  const acts = Array.isArray(r.actions) ? (r.actions as Act[]) : []
  return {
    id: r.id, name: r.name, trigger: r.trigger,
    conditions: conds.length ? conds.map((c) => ({ field: c.field, op: c.op, value: c.value != null ? String(c.value) : '' })) : [],
    actions: acts.length ? acts : [{ type: 'log_only' }],
    enabled: r.enabled, dryRun: r.dryRun,
    maxExecutionsPerDay: r.maxExecutionsPerDay != null ? String(r.maxExecutionsPerDay) : '',
    maxValueCentsEur: r.maxValueCentsEur != null ? String(r.maxValueCentsEur) : '',
  }
}

// Serialise a draft → API body. Numeric condition values are coerced.
function toBody(d: Draft) {
  const conditions = d.conditions
    .filter((c) => c.field.trim())
    .map((c) => {
      const raw = c.value ?? ''
      const num = raw !== '' && !Number.isNaN(Number(raw)) ? Number(raw) : raw
      return c.op === 'exists' ? { field: c.field.trim(), op: c.op } : { field: c.field.trim(), op: c.op, value: num }
    })
  const actions = d.actions.map((a) => {
    const base: Record<string, unknown> = { type: a.type }
    const csv = (s?: string) => (s && s.trim() ? s.split(',').map((x) => x.trim()).filter(Boolean) : undefined)
    if (a.type === 'sync_price_to_marketplaces') {
      base.referencePrice = a.referencePrice ?? 'master'
      base.onlySameCurrency = a.onlySameCurrency !== false
      base.channels = csv(a.channels); base.marketplaces = csv(a.marketplaces)
    } else if (a.type === 'sync_inventory_to_marketplaces') {
      if (a.quantity && a.quantity.trim()) base.quantity = Number(a.quantity)
      base.channels = csv(a.channels); base.marketplaces = csv(a.marketplaces)
    } else if (a.type === 'cascade_translate_content') {
      if (a.sourceLanguage && a.sourceLanguage.trim()) base.sourceLanguage = a.sourceLanguage.trim()
      base.channels = csv(a.channels); base.marketplaces = csv(a.marketplaces)
    } else if (a.type === 'notify') {
      base.message = a.message ?? ''
    }
    return base
  })
  return {
    name: d.name.trim(), trigger: d.trigger, conditions, actions,
    enabled: d.enabled, dryRun: d.dryRun,
    maxExecutionsPerDay: d.maxExecutionsPerDay.trim() === '' ? null : Number(d.maxExecutionsPerDay),
    maxValueCentsEur: d.maxValueCentsEur.trim() === '' ? null : Number(d.maxValueCentsEur),
  }
}

const STATUS_TONE: Record<string, string> = {
  SUCCESS: 'text-emerald-600 dark:text-emerald-400', DRY_RUN: 'text-amber-600 dark:text-amber-400',
  PARTIAL: 'text-amber-600 dark:text-amber-400', NO_MATCH: 'text-tertiary',
  FAILED: 'text-rose-600 dark:text-rose-400', CAP_EXCEEDED: 'text-rose-600 dark:text-rose-400',
}

export default function AutomationClient() {
  const confirm = useConfirm()
  const [rules, setRules] = useState<Rule[]>([])
  const [loading, setLoading] = useState(true)
  const [draft, setDraft] = useState<Draft | null>(null)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [executions, setExecutions] = useState<Execution[]>([])
  const [testResult, setTestResult] = useState<string | null>(null)

  const load = useCallback(() => {
    setLoading(true)
    fetch(`${getBackendUrl()}/api/listing-automation-rules`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((j: { rules?: Rule[] }) => setRules(j.rules ?? []))
      .catch((e) => setError(e?.message ?? 'Failed to load'))
      .finally(() => setLoading(false))
  }, [])
  useEffect(() => { load() }, [load])

  const loadExecutions = useCallback((id: string) => {
    fetch(`${getBackendUrl()}/api/listing-automation-rules/${id}/executions?limit=20`)
      .then((r) => (r.ok ? r.json() : null))
      .then((j: { executions?: Execution[] } | null) => setExecutions(j?.executions ?? []))
      .catch(() => setExecutions([]))
  }, [])

  function editRule(r: Rule) {
    setDraft(toDraft(r)); setTestResult(null); setError(null); loadExecutions(r.id)
  }
  function newRule() {
    setDraft(emptyDraft()); setTestResult(null); setError(null); setExecutions([])
  }

  async function save() {
    if (!draft) return
    if (!draft.name.trim()) { setError('Name is required'); return }
    setSaving(true); setError(null)
    try {
      const body = toBody(draft)
      const url = draft.id
        ? `${getBackendUrl()}/api/listing-automation-rules/${draft.id}`
        : `${getBackendUrl()}/api/listing-automation-rules`
      const res = await fetch(url, {
        method: draft.id ? 'PATCH' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      const j = await res.json().catch(() => null)
      if (!res.ok || j?.success === false) throw new Error(j?.error ?? `HTTP ${res.status}`)
      setDraft(null); load()
    } catch (e: any) {
      setError(e?.message ?? 'Save failed')
    } finally {
      setSaving(false)
    }
  }

  async function toggleEnabled(r: Rule) {
    await fetch(`${getBackendUrl()}/api/listing-automation-rules/${r.id}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: !r.enabled }),
    })
    load()
  }

  async function remove(r: Rule) {
    const ok = await confirm({ title: 'Delete rule?', description: `“${r.name}” will be removed. This cannot be undone.`, confirmLabel: 'Delete', tone: 'danger' })
    if (!ok) return
    await fetch(`${getBackendUrl()}/api/listing-automation-rules/${r.id}`, { method: 'DELETE' })
    if (draft?.id === r.id) setDraft(null)
    load()
  }

  // Dry-run an existing rule against a representative sample context.
  async function test() {
    if (!draft?.id) { setTestResult('Save the rule first to test it against the engine.'); return }
    setTestResult('Running…')
    const sample = {
      trigger: draft.trigger,
      product: { id: 'sample', sku: 'SAMPLE-SKU', name: 'Sample product', basePrice: 99 },
      listings: [{ channel: 'AMAZON', marketplace: 'IT', price: 99, currency: 'EUR' }],
      price: { min: 89, max: 119, spreadPct: 33.7, currency: 'EUR' },
      inventory: { available: 3 },
      health: { score: 45, ready: 1, total: 3, blocked: 2 },
    }
    try {
      const res = await fetch(`${getBackendUrl()}/api/listing-automation-rules/${draft.id}/dry-run`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ context: sample }),
      })
      const j = await res.json().catch(() => null)
      if (!res.ok || j?.success === false) throw new Error(j?.error ?? `HTTP ${res.status}`)
      const r = j.result
      setTestResult(`${r.matched ? 'MATCHED' : 'no match'} · status ${r.status}` + (r.actionResults?.length ? ` · ${r.actionResults.map((a: any) => `${a.type}:${a.ok ? 'ok' : a.error}`).join(', ')}` : ''))
      if (draft.id) loadExecutions(draft.id)
    } catch (e: any) {
      setTestResult(`Error: ${e?.message ?? e}`)
    }
  }

  const trig = (id: string) => TRIGGERS.find((t) => t.id === id)

  return (
    <div className="grid grid-cols-1 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.3fr)] gap-3">
      {/* ── Rules list ─────────────────────────────────────────────── */}
      <div className="rounded-lg border border-default dark:border-slate-800 bg-white dark:bg-slate-900">
        <div className="px-4 py-3 flex items-center justify-between border-b border-subtle dark:border-slate-800">
          <div className="text-sm font-semibold text-slate-900 dark:text-slate-100">Rules</div>
          <Button size="sm" icon={<Plus className="w-3.5 h-3.5" />} onClick={newRule}>New rule</Button>
        </div>
        {loading ? (
          <div className="p-6 flex items-center gap-2 text-sm text-tertiary"><Loader2 className="w-4 h-4 animate-spin" /> Loading…</div>
        ) : rules.length === 0 ? (
          <div className="p-6 text-sm text-tertiary">No listing rules yet. Create one — it ships disabled + dry-run, so it’s safe to experiment.</div>
        ) : (
          <ul className="divide-y divide-slate-100 dark:divide-slate-800">
            {rules.map((r) => (
              <li key={r.id} className={cn('px-4 py-2.5 flex items-center justify-between gap-2 cursor-pointer hover:bg-slate-50 dark:hover:bg-slate-800/50', draft?.id === r.id && 'bg-blue-50/50 dark:bg-blue-950/20')} onClick={() => editRule(r)}>
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium text-slate-800 dark:text-slate-200 truncate">{r.name}</span>
                    {r.dryRun && <Badge variant="warning">dry-run</Badge>}
                  </div>
                  <div className="text-xs text-slate-500 dark:text-slate-400 truncate">{trig(r.trigger)?.label ?? r.trigger}</div>
                </div>
                <div className="flex items-center gap-1 flex-shrink-0" onClick={(e) => e.stopPropagation()}>
                  <button type="button" aria-label={r.enabled ? 'Disable' : 'Enable'} onClick={() => void toggleEnabled(r)} className={cn('p-1 rounded', r.enabled ? 'text-emerald-600' : 'text-tertiary')}>
                    {r.enabled ? <Play className="w-4 h-4" /> : <Pause className="w-4 h-4" />}
                  </button>
                  <button type="button" aria-label="Delete" onClick={() => void remove(r)} className="p-1 rounded text-tertiary hover:text-rose-500"><Trash2 className="w-4 h-4" /></button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* ── Builder ────────────────────────────────────────────────── */}
      <div className="rounded-lg border border-default dark:border-slate-800 bg-white dark:bg-slate-900">
        {!draft ? (
          <div className="p-6 text-sm text-tertiary">Select a rule to edit, or create a new one.</div>
        ) : (
          <div className="p-4 space-y-4">
            <div className="flex items-center justify-between">
              <div className="text-sm font-semibold text-slate-900 dark:text-slate-100">{draft.id ? 'Edit rule' : 'New rule'}</div>
              <button type="button" onClick={() => setDraft(null)} aria-label="Close"><X className="w-4 h-4 text-tertiary" /></button>
            </div>

            {error && <div className="text-sm text-rose-600 dark:text-rose-400">{error}</div>}

            <label className="block">
              <span className="text-xs text-slate-500 dark:text-slate-400">Name</span>
              <input value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} className="mt-1 w-full rounded border border-default dark:border-slate-700 bg-white dark:bg-slate-900 px-2 py-1.5 text-sm" placeholder="e.g. Match Amazon DE/FR to master when price diverges >10%" />
            </label>

            {/* Trigger */}
            <label className="block">
              <span className="text-xs text-slate-500 dark:text-slate-400">When (trigger)</span>
              <Listbox
                options={TRIGGERS.map((tr) => ({ value: tr.id, label: tr.label }))}
                value={draft.trigger}
                onChange={(v) => setDraft({ ...draft, trigger: v })}
                ariaLabel="When (trigger)"
                className="mt-1 w-full"
              />
              <span className="mt-1 block text-[11px] text-tertiary">{trig(draft.trigger)?.help}</span>
            </label>

            {/* Conditions */}
            <div>
              <div className="flex items-center justify-between mb-1">
                <span className="text-xs text-slate-500 dark:text-slate-400">And (conditions — all must hold)</span>
                <button type="button" className="text-xs text-blue-600 hover:underline" onClick={() => setDraft({ ...draft, conditions: [...draft.conditions, { field: '', op: 'gt', value: '' }] })}>+ condition</button>
              </div>
              <div className="space-y-1.5">
                {draft.conditions.length === 0 && <div className="text-[11px] text-tertiary">No conditions — fires on every trigger (pair with a low daily cap).</div>}
                {draft.conditions.map((c, i) => (
                  <div key={i} className="flex items-center gap-1.5">
                    <input value={c.field} onChange={(e) => { const n = [...draft.conditions]; n[i] = { ...c, field: e.target.value }; setDraft({ ...draft, conditions: n }) }} placeholder="price.spreadPct" className="flex-1 rounded border border-default dark:border-slate-700 bg-white dark:bg-slate-900 px-2 py-1 text-xs font-mono" />
                    <Listbox
                      options={OPS.map((o) => ({ value: o, label: o }))}
                      value={c.op}
                      onChange={(v) => { const n = [...draft.conditions]; n[i] = { ...c, op: v }; setDraft({ ...draft, conditions: n }) }}
                      ariaLabel="Condition operator"
                      className="w-24"
                    />
                    {c.op !== 'exists' && <input value={c.value ?? ''} onChange={(e) => { const n = [...draft.conditions]; n[i] = { ...c, value: e.target.value }; setDraft({ ...draft, conditions: n }) }} placeholder="10" className="w-20 rounded border border-default dark:border-slate-700 bg-white dark:bg-slate-900 px-2 py-1 text-xs" />}
                    <button type="button" onClick={() => setDraft({ ...draft, conditions: draft.conditions.filter((_, j) => j !== i) })} className="text-tertiary hover:text-rose-500"><X className="w-3.5 h-3.5" /></button>
                  </div>
                ))}
              </div>
            </div>

            {/* Actions */}
            <div>
              <div className="flex items-center justify-between mb-1">
                <span className="text-xs text-slate-500 dark:text-slate-400">Then (actions)</span>
                <button type="button" className="text-xs text-blue-600 hover:underline" onClick={() => setDraft({ ...draft, actions: [...draft.actions, { type: 'notify', message: '' }] })}>+ action</button>
              </div>
              <div className="space-y-2">
                {draft.actions.map((a, i) => {
                  const set = (patch: Partial<Act>) => { const n = [...draft.actions]; n[i] = { ...a, ...patch }; setDraft({ ...draft, actions: n }) }
                  return (
                    <div key={i} className="rounded border border-default dark:border-slate-700 p-2 space-y-1.5">
                      <div className="flex items-center gap-1.5">
                        <Listbox
                          options={ACTION_TYPES.map((at) => ({ value: at.id, label: at.label }))}
                          value={a.type}
                          onChange={(v) => set({ type: v })}
                          ariaLabel="Action type"
                          className="flex-1"
                        />
                        <button type="button" onClick={() => setDraft({ ...draft, actions: draft.actions.filter((_, j) => j !== i) })} className="text-tertiary hover:text-rose-500"><X className="w-3.5 h-3.5" /></button>
                      </div>
                      {a.type === 'sync_price_to_marketplaces' && (
                        <div className="grid grid-cols-2 gap-1.5 text-xs">
                          <label className="flex flex-col">Reference price
                            <Listbox
                              options={[
                                { value: 'master', label: 'Master (basePrice)' },
                                { value: 'min', label: 'Lowest market' },
                                { value: 'max', label: 'Highest market' },
                              ]}
                              value={a.referencePrice ?? 'master'}
                              onChange={(v) => set({ referencePrice: v })}
                              ariaLabel="Reference price"
                              className="mt-0.5"
                            />
                          </label>
                          <label className="flex items-center gap-1.5 mt-4"><input type="checkbox" checked={a.onlySameCurrency !== false} onChange={(e) => set({ onlySameCurrency: e.target.checked })} /> Same currency only</label>
                          <input value={a.channels ?? ''} onChange={(e) => set({ channels: e.target.value })} placeholder="channels (AMAZON,EBAY)" className="rounded border border-default dark:border-slate-700 bg-white dark:bg-slate-900 px-2 py-1" />
                          <input value={a.marketplaces ?? ''} onChange={(e) => set({ marketplaces: e.target.value })} placeholder="markets (DE,FR)" className="rounded border border-default dark:border-slate-700 bg-white dark:bg-slate-900 px-2 py-1" />
                        </div>
                      )}
                      {a.type === 'sync_inventory_to_marketplaces' && (
                        <div className="grid grid-cols-2 gap-1.5 text-xs">
                          <input value={a.quantity ?? ''} onChange={(e) => set({ quantity: e.target.value })} placeholder="quantity (blank = from context)" className="rounded border border-default dark:border-slate-700 bg-white dark:bg-slate-900 px-2 py-1" />
                          <span />
                          <input value={a.channels ?? ''} onChange={(e) => set({ channels: e.target.value })} placeholder="channels (AMAZON,EBAY)" className="rounded border border-default dark:border-slate-700 bg-white dark:bg-slate-900 px-2 py-1" />
                          <input value={a.marketplaces ?? ''} onChange={(e) => set({ marketplaces: e.target.value })} placeholder="markets (DE,FR)" className="rounded border border-default dark:border-slate-700 bg-white dark:bg-slate-900 px-2 py-1" />
                        </div>
                      )}
                      {a.type === 'cascade_translate_content' && (
                        <div className="grid grid-cols-2 gap-1.5 text-xs">
                          <input value={a.sourceLanguage ?? ''} onChange={(e) => set({ sourceLanguage: e.target.value })} placeholder="source lang (en)" className="rounded border border-default dark:border-slate-700 bg-white dark:bg-slate-900 px-2 py-1" />
                          <span />
                          <input value={a.channels ?? ''} onChange={(e) => set({ channels: e.target.value })} placeholder="channels (AMAZON,EBAY)" className="rounded border border-default dark:border-slate-700 bg-white dark:bg-slate-900 px-2 py-1" />
                          <input value={a.marketplaces ?? ''} onChange={(e) => set({ marketplaces: e.target.value })} placeholder="markets (DE,FR)" className="rounded border border-default dark:border-slate-700 bg-white dark:bg-slate-900 px-2 py-1" />
                        </div>
                      )}
                      {a.type === 'notify' && (
                        <input value={a.message ?? ''} onChange={(e) => set({ message: e.target.value })} placeholder="Message to log/notify" className="w-full rounded border border-default dark:border-slate-700 bg-white dark:bg-slate-900 px-2 py-1 text-xs" />
                      )}
                      <span className="block text-[10.5px] text-tertiary">{ACTION_TYPES.find((t) => t.id === a.type)?.help}</span>
                    </div>
                  )
                })}
              </div>
            </div>

            {/* Guardrails */}
            <div className="grid grid-cols-2 gap-2 text-xs">
              <label className="flex items-center gap-1.5"><input type="checkbox" checked={draft.enabled} onChange={(e) => setDraft({ ...draft, enabled: e.target.checked })} /> Enabled</label>
              <label className="flex items-center gap-1.5"><input type="checkbox" checked={draft.dryRun} onChange={(e) => setDraft({ ...draft, dryRun: e.target.checked })} /> Dry-run (no writes)</label>
              <label className="flex flex-col">Max executions/day
                <input value={draft.maxExecutionsPerDay} onChange={(e) => setDraft({ ...draft, maxExecutionsPerDay: e.target.value })} placeholder="50" className="mt-0.5 rounded border border-default dark:border-slate-700 bg-white dark:bg-slate-900 px-2 py-1" />
              </label>
              <label className="flex flex-col">Max value (€ cents/exec)
                <input value={draft.maxValueCentsEur} onChange={(e) => setDraft({ ...draft, maxValueCentsEur: e.target.value })} placeholder="(none)" className="mt-0.5 rounded border border-default dark:border-slate-700 bg-white dark:bg-slate-900 px-2 py-1" />
              </label>
            </div>

            {!draft.dryRun && draft.enabled && (
              <div className="flex items-start gap-1.5 text-[11px] text-amber-700 dark:text-amber-400"><AlertTriangle className="w-3.5 h-3.5 flex-shrink-0 mt-0.5" /> This rule is LIVE — matching actions will enqueue real marketplace syncs (with a 5-min undo window).</div>
            )}

            <div className="flex items-center gap-2 pt-1">
              <Button variant="primary" icon={<Save className="w-4 h-4" />} loading={saving} onClick={() => void save()}>Save</Button>
              <Button variant="secondary" icon={<TestTube className="w-4 h-4" />} onClick={() => void test()} disabled={!draft.id}>Test (dry-run)</Button>
              {testResult && <span className="text-xs text-slate-600 dark:text-slate-300">{testResult}</span>}
            </div>

            {/* History */}
            {draft.id && (
              <div className="pt-2 border-t border-subtle dark:border-slate-800">
                <div className="flex items-center gap-1.5 text-xs font-medium text-slate-500 dark:text-slate-400 mb-1"><HistoryIcon className="w-3.5 h-3.5" /> Recent runs</div>
                {executions.length === 0 ? (
                  <div className="text-[11px] text-tertiary">No runs yet.</div>
                ) : (
                  <ul className="space-y-0.5">
                    {executions.map((e) => (
                      <li key={e.id} className="flex items-center justify-between text-[11px]">
                        <span className={cn('font-medium', STATUS_TONE[e.status] ?? 'text-slate-500')}>
                          {e.status === 'SUCCESS' ? <CheckCircle2 className="inline w-3 h-3 mr-1" /> : null}{e.status}{e.dryRun ? ' (dry)' : ''}
                        </span>
                        <span className="text-tertiary">{new Date(e.startedAt).toLocaleString()}{e.errorMessage ? ` · ${e.errorMessage}` : ''}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
