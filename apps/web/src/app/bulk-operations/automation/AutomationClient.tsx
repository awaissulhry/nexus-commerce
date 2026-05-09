'use client'

/**
 * W7.5 — Visual builder UI shell.
 *
 * List view + builder for bulk-ops AutomationRule. Three panels in
 * one page: list, builder, run history (W7.8 wires the history side
 * to AutomationRuleExecution).
 *
 * The builder lays out trigger → conditions tree → actions
 * vertically — operators read top-to-bottom what fires the rule,
 * what filters its match, and what runs when it matches. v0 ships
 * a flat conditions list (single AND group) but the underlying
 * data shape supports the W7.3 tree, so a "+ Group" affordance
 * lights up nesting in a follow-up commit without re-shaping the
 * persisted JSON.
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  AlertTriangle,
  ChevronRight,
  Loader2,
  Pause,
  Play,
  Plus,
  Save,
  Sparkles,
  TestTube,
  Trash2,
  Wand2,
  X,
} from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { Badge } from '@/components/ui/Badge'
import { useConfirm } from '@/components/ui/ConfirmProvider'
import { getBackendUrl } from '@/lib/backend-url'
import { cn } from '@/lib/utils'

const TRIGGERS = [
  { id: 'bulk_job_completed', label: 'Bulk job finished', helpText: 'Fires after every BulkActionJob terminates (COMPLETED / FAILED / PARTIAL / CANCELLED).' },
  { id: 'bulk_job_failed_burst', label: 'Failure burst detected', helpText: 'Fires when the failure-burst detector sees too many failed jobs in the last hour.' },
  { id: 'schedule_fired', label: 'Schedule fired', helpText: 'Fires after a ScheduledBulkAction successfully creates a job.' },
  { id: 'bulk_cron_tick', label: 'Recurring 15-min tick', helpText: 'Fires every 15 minutes on the bulk-ops domain clock — for time-based hygiene rules.' },
] as const

const ACTION_TYPES = [
  { id: 'apply_bulk_template', label: 'Apply template', helpText: 'Fire a saved BulkActionTemplate with parameters.' },
  { id: 'create_bulk_job', label: 'Create bulk job', helpText: 'Inline bulk-job creation (actionType + actionPayload + filters supplied directly).' },
  { id: 'pause_schedules_matching', label: 'Pause schedules', helpText: 'Bulk-pause ScheduledBulkAction rows by actionType.' },
  { id: 'notify', label: 'Notify operator', helpText: 'Log + (future) in-app notification.' },
  { id: 'log_only', label: 'Log only', helpText: 'Audit-only — record an execution row but take no action.' },
] as const

const COMMON_OPS = ['eq', 'ne', 'lt', 'lte', 'gt', 'gte', 'contains', 'exists'] as const

interface Rule {
  id: string
  name: string
  description: string | null
  domain: string
  trigger: string
  conditions: unknown
  actions: unknown[]
  enabled: boolean
  dryRun: boolean
  maxExecutionsPerDay: number | null
  maxValueCentsEur: number | null
  evaluationCount: number
  matchCount: number
  executionCount: number
  lastEvaluatedAt: string | null
  lastMatchedAt: string | null
  lastExecutedAt: string | null
  createdAt: string
  updatedAt: string
}

interface Condition {
  field: string
  op: string
  value: unknown
}

interface ActionDraft {
  type: string
  [key: string]: unknown
}

interface Draft {
  name: string
  description: string
  trigger: string
  conditions: Condition[]
  actions: ActionDraft[]
  enabled: boolean
  dryRun: boolean
  maxExecutionsPerDay: number | null
}

const EMPTY_DRAFT: Draft = {
  name: '',
  description: '',
  trigger: TRIGGERS[0].id,
  conditions: [],
  actions: [{ type: 'log_only' }],
  enabled: false,
  dryRun: true,
  maxExecutionsPerDay: 100,
}

export default function AutomationClient() {
  const confirm = useConfirm()
  const [rules, setRules] = useState<Rule[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [draft, setDraft] = useState<Draft>(EMPTY_DRAFT)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [tested, setTested] = useState<{
    matched: boolean
    actionsPreview: ActionDraft[]
  } | null>(null)
  const [testing, setTesting] = useState(false)

  const fetchRules = useCallback(async () => {
    try {
      const res = await fetch(
        `${getBackendUrl()}/api/bulk-automation-rules?limit=200`,
        { cache: 'no-store' },
      )
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        throw new Error(body.error ?? `HTTP ${res.status}`)
      }
      const data = await res.json()
      setRules(Array.isArray(data.rules) ? data.rules : [])
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    fetchRules()
  }, [fetchRules])

  const startNew = () => {
    setDraft(EMPTY_DRAFT)
    setEditingId(null)
    setTested(null)
  }

  const startEdit = (r: Rule) => {
    setDraft({
      name: r.name,
      description: r.description ?? '',
      trigger: r.trigger,
      conditions: Array.isArray(r.conditions) ? (r.conditions as Condition[]) : [],
      actions: Array.isArray(r.actions) ? (r.actions as ActionDraft[]) : [],
      enabled: r.enabled,
      dryRun: r.dryRun,
      maxExecutionsPerDay: r.maxExecutionsPerDay,
    })
    setEditingId(r.id)
    setTested(null)
  }

  const setEnabled = async (r: Rule, enabled: boolean) => {
    try {
      const res = await fetch(
        `${getBackendUrl()}/api/bulk-automation-rules/${r.id}`,
        {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ enabled }),
        },
      )
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        throw new Error(body.error ?? `HTTP ${res.status}`)
      }
      await fetchRules()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  const deleteRule = async (r: Rule) => {
    const ok = await confirm({
      title: `Delete rule "${r.name}"?`,
      description: 'The rule stops evaluating immediately. Past execution history is kept for audit.',
      confirmLabel: 'Delete',
      tone: 'danger',
    })
    if (!ok) return
    try {
      const res = await fetch(
        `${getBackendUrl()}/api/bulk-automation-rules/${r.id}`,
        { method: 'DELETE' },
      )
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        throw new Error(body.error ?? `HTTP ${res.status}`)
      }
      await fetchRules()
      if (editingId === r.id) startNew()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  const save = async () => {
    if (!draft.name.trim()) return
    setSaving(true)
    setError(null)
    try {
      const body = {
        name: draft.name.trim(),
        description: draft.description.trim() || null,
        trigger: draft.trigger,
        conditions: draft.conditions,
        actions: draft.actions,
        enabled: draft.enabled,
        dryRun: draft.dryRun,
        maxExecutionsPerDay: draft.maxExecutionsPerDay,
      }
      const url = editingId
        ? `${getBackendUrl()}/api/bulk-automation-rules/${editingId}`
        : `${getBackendUrl()}/api/bulk-automation-rules`
      const res = await fetch(url, {
        method: editingId ? 'PATCH' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      if (!res.ok) {
        const j = await res.json().catch(() => ({}))
        throw new Error(j.error ?? `HTTP ${res.status}`)
      }
      const j = await res.json()
      await fetchRules()
      if (j.rule?.id) setEditingId(j.rule.id)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setSaving(false)
    }
  }

  const testInline = async () => {
    setTesting(true)
    try {
      const res = await fetch(
        `${getBackendUrl()}/api/bulk-automation-rules/dry-run-inline`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            trigger: draft.trigger,
            conditions: draft.conditions,
            actions: draft.actions,
            // Sample context — operators tweak via the textarea below.
            context: {},
          }),
        },
      )
      const j = await res.json()
      if (!res.ok) throw new Error(j.error ?? `HTTP ${res.status}`)
      setTested({
        matched: j.matched,
        actionsPreview: j.actionsPreview ?? [],
      })
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setTesting(false)
    }
  }

  const triggerMeta = useMemo(
    () => TRIGGERS.find((t) => t.id === draft.trigger),
    [draft.trigger],
  )

  return (
    <div className="px-3 md:px-6 grid grid-cols-1 lg:grid-cols-[320px_1fr] gap-4">
      {/* ── Left: rule list ────────────────────────────────────── */}
      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <div className="text-sm font-semibold text-slate-700 dark:text-slate-300 inline-flex items-center gap-1.5">
            <Wand2 className="w-3.5 h-3.5 text-purple-500" />
            Rules
            {rules.length > 0 && (
              <span className="text-xs text-slate-400 tabular-nums">
                {rules.length}
              </span>
            )}
          </div>
          <Button variant="primary" size="sm" onClick={startNew}>
            <Plus className="w-3 h-3 mr-1" />
            New
          </Button>
        </div>
        {error && (
          <div className="text-xs text-red-700 dark:text-red-300 bg-red-50 dark:bg-red-950/40 border border-red-200 dark:border-red-900 rounded px-2 py-1">
            {error}
          </div>
        )}
        {loading && rules.length === 0 ? (
          <div className="text-sm text-slate-500 inline-flex items-center gap-1.5">
            <Loader2 className="w-3.5 h-3.5 animate-spin" />
            Loading…
          </div>
        ) : rules.length === 0 ? (
          <div className="bg-white dark:bg-slate-900 border border-dashed border-slate-200 dark:border-slate-800 rounded p-4 text-center text-sm text-slate-500">
            No rules yet. Hit <strong>+ New</strong> and configure your
            first trigger / conditions / actions stack.
          </div>
        ) : (
          <div className="space-y-1">
            {rules.map((r) => (
              <button
                key={r.id}
                type="button"
                onClick={() => startEdit(r)}
                className={cn(
                  'w-full text-left rounded border px-2 py-1.5 transition-colors',
                  editingId === r.id
                    ? 'border-purple-300 bg-purple-50 dark:bg-purple-950/40'
                    : 'border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 hover:bg-slate-50 dark:hover:bg-slate-800',
                )}
              >
                <div className="flex items-center gap-1.5">
                  <span
                    className={cn(
                      'h-1.5 w-1.5 rounded-full',
                      r.enabled
                        ? r.dryRun
                          ? 'bg-amber-500'
                          : 'bg-emerald-500'
                        : 'bg-slate-300',
                    )}
                  />
                  <span className="text-sm font-medium truncate flex-1">
                    {r.name}
                  </span>
                  <ChevronRight className="w-3 h-3 text-slate-400 flex-shrink-0" />
                </div>
                <div className="flex items-center gap-1 mt-0.5">
                  <Badge variant="default" size="sm">
                    {r.trigger.replace(/_/g, ' ')}
                  </Badge>
                  {r.dryRun && (
                    <Badge variant="warning" size="sm">
                      Dry-run
                    </Badge>
                  )}
                  {!r.enabled && (
                    <Badge variant="default" size="sm">
                      Off
                    </Badge>
                  )}
                </div>
                <div className="text-[10px] text-slate-400 mt-0.5 tabular-nums">
                  {r.executionCount} exec · {r.matchCount} match · {r.evaluationCount} eval
                </div>
              </button>
            ))}
          </div>
        )}
      </div>

      {/* ── Right: builder ────────────────────────────────────── */}
      <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-lg p-4 space-y-4">
        <div className="flex items-center justify-between">
          <h2 className="text-base font-semibold text-slate-800 dark:text-slate-100 inline-flex items-center gap-1.5">
            <Sparkles className="w-4 h-4 text-amber-500" />
            {editingId ? 'Edit rule' : 'New rule'}
          </h2>
          {editingId && (
            <div className="flex items-center gap-1">
              {(() => {
                const r = rules.find((x) => x.id === editingId)
                if (!r) return null
                return (
                  <>
                    <button
                      type="button"
                      onClick={() => setEnabled(r, !r.enabled)}
                      className="h-7 px-2 text-xs font-medium border border-slate-200 dark:border-slate-700 rounded inline-flex items-center gap-1 hover:bg-slate-50 dark:hover:bg-slate-800"
                    >
                      {r.enabled ? (
                        <>
                          <Pause className="w-3 h-3" /> Pause
                        </>
                      ) : (
                        <>
                          <Play className="w-3 h-3" /> Activate
                        </>
                      )}
                    </button>
                    <button
                      type="button"
                      onClick={() => deleteRule(r)}
                      className="h-7 w-7 inline-flex items-center justify-center text-slate-500 hover:text-red-600 hover:bg-red-50 dark:hover:bg-red-950/40 rounded"
                      title="Delete rule"
                    >
                      <Trash2 className="w-3 h-3" />
                    </button>
                  </>
                )
              })()}
            </div>
          )}
        </div>

        <label className="block">
          <span className="text-xs font-medium text-slate-600 dark:text-slate-300 mb-0.5 block">
            Name
          </span>
          <input
            type="text"
            value={draft.name}
            onChange={(e) => setDraft({ ...draft, name: e.target.value })}
            placeholder='e.g. "Pause schedules on failure burst"'
            className="w-full h-8 px-2 text-sm border border-slate-200 dark:border-slate-700 dark:bg-slate-900 rounded outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500"
          />
        </label>

        <label className="block">
          <span className="text-xs font-medium text-slate-600 dark:text-slate-300 mb-0.5 block">
            Description
          </span>
          <input
            type="text"
            value={draft.description}
            onChange={(e) => setDraft({ ...draft, description: e.target.value })}
            placeholder="What this rule does (optional)"
            className="w-full h-8 px-2 text-sm border border-slate-200 dark:border-slate-700 dark:bg-slate-900 rounded outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500"
          />
        </label>

        {/* Trigger panel */}
        <section className="border border-slate-200 dark:border-slate-800 rounded p-2 space-y-1.5">
          <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">
            1. Trigger
          </div>
          <select
            value={draft.trigger}
            onChange={(e) => setDraft({ ...draft, trigger: e.target.value })}
            className="w-full h-8 px-2 text-sm border border-slate-200 dark:border-slate-700 dark:bg-slate-900 rounded"
          >
            {TRIGGERS.map((t) => (
              <option key={t.id} value={t.id}>
                {t.label}
              </option>
            ))}
          </select>
          {triggerMeta?.helpText && (
            <div className="text-xs text-slate-500">{triggerMeta.helpText}</div>
          )}
        </section>

        {/* Conditions panel */}
        <section className="border border-slate-200 dark:border-slate-800 rounded p-2 space-y-1.5">
          <div className="text-xs font-semibold uppercase tracking-wide text-slate-500 flex items-center justify-between">
            <span>2. Conditions (all must match)</span>
            <button
              type="button"
              onClick={() =>
                setDraft({
                  ...draft,
                  conditions: [
                    ...draft.conditions,
                    { field: '', op: 'eq', value: '' },
                  ],
                })
              }
              className="text-xs font-medium text-blue-600 dark:text-blue-400 hover:underline inline-flex items-center"
            >
              <Plus className="w-3 h-3 mr-0.5" /> Add condition
            </button>
          </div>
          {draft.conditions.length === 0 && (
            <div className="text-xs text-slate-500">
              No conditions — rule fires on every trigger.
            </div>
          )}
          {draft.conditions.map((c, i) => (
            <div key={i} className="flex items-center gap-1">
              <input
                type="text"
                value={c.field}
                onChange={(e) => {
                  const next = [...draft.conditions]
                  next[i] = { ...c, field: e.target.value }
                  setDraft({ ...draft, conditions: next })
                }}
                placeholder="job.failureRate"
                className="flex-1 h-7 px-2 text-xs font-mono border border-slate-200 dark:border-slate-700 dark:bg-slate-900 rounded"
              />
              <select
                value={c.op}
                onChange={(e) => {
                  const next = [...draft.conditions]
                  next[i] = { ...c, op: e.target.value }
                  setDraft({ ...draft, conditions: next })
                }}
                className="h-7 px-1.5 text-xs border border-slate-200 dark:border-slate-700 dark:bg-slate-900 rounded"
              >
                {COMMON_OPS.map((op) => (
                  <option key={op} value={op}>
                    {op}
                  </option>
                ))}
              </select>
              <input
                type="text"
                value={String(c.value ?? '')}
                onChange={(e) => {
                  const next = [...draft.conditions]
                  next[i] = { ...c, value: e.target.value }
                  setDraft({ ...draft, conditions: next })
                }}
                placeholder="0.2"
                className="flex-1 h-7 px-2 text-xs border border-slate-200 dark:border-slate-700 dark:bg-slate-900 rounded"
              />
              <button
                type="button"
                onClick={() =>
                  setDraft({
                    ...draft,
                    conditions: draft.conditions.filter((_, j) => j !== i),
                  })
                }
                className="h-7 w-7 inline-flex items-center justify-center text-slate-500 hover:text-red-600 hover:bg-red-50 dark:hover:bg-red-950/40 rounded"
                aria-label="Remove condition"
              >
                <X className="w-3 h-3" />
              </button>
            </div>
          ))}
        </section>

        {/* Actions panel */}
        <section className="border border-slate-200 dark:border-slate-800 rounded p-2 space-y-1.5">
          <div className="text-xs font-semibold uppercase tracking-wide text-slate-500 flex items-center justify-between">
            <span>3. Actions (in order)</span>
            <button
              type="button"
              onClick={() =>
                setDraft({
                  ...draft,
                  actions: [...draft.actions, { type: 'log_only' }],
                })
              }
              className="text-xs font-medium text-blue-600 dark:text-blue-400 hover:underline inline-flex items-center"
            >
              <Plus className="w-3 h-3 mr-0.5" /> Add action
            </button>
          </div>
          {draft.actions.length === 0 && (
            <div className="text-xs text-amber-700 dark:text-amber-300 inline-flex items-center gap-1">
              <AlertTriangle className="w-3 h-3" />
              At least one action recommended.
            </div>
          )}
          {draft.actions.map((a, i) => (
            <div
              key={i}
              className="border border-slate-100 dark:border-slate-800 rounded p-1.5 space-y-1"
            >
              <div className="flex items-center gap-1.5">
                <select
                  value={a.type}
                  onChange={(e) => {
                    const next = [...draft.actions]
                    next[i] = { type: e.target.value }
                    setDraft({ ...draft, actions: next })
                  }}
                  className="flex-1 h-7 px-1.5 text-xs border border-slate-200 dark:border-slate-700 dark:bg-slate-900 rounded"
                >
                  {ACTION_TYPES.map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.label}
                    </option>
                  ))}
                </select>
                <button
                  type="button"
                  onClick={() =>
                    setDraft({
                      ...draft,
                      actions: draft.actions.filter((_, j) => j !== i),
                    })
                  }
                  className="h-7 w-7 inline-flex items-center justify-center text-slate-500 hover:text-red-600 hover:bg-red-50 dark:hover:bg-red-950/40 rounded"
                  aria-label="Remove action"
                >
                  <X className="w-3 h-3" />
                </button>
              </div>
              <div className="text-[10px] text-slate-400 pl-1">
                {ACTION_TYPES.find((t) => t.id === a.type)?.helpText}
              </div>
            </div>
          ))}
        </section>

        {/* Safety controls */}
        <section className="border border-slate-200 dark:border-slate-800 rounded p-2 space-y-1.5">
          <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">
            4. Safety
          </div>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={draft.dryRun}
              onChange={(e) => setDraft({ ...draft, dryRun: e.target.checked })}
            />
            <span>Dry-run mode (preview only — no writes)</span>
          </label>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={draft.enabled}
              onChange={(e) =>
                setDraft({ ...draft, enabled: e.target.checked })
              }
            />
            <span>Enabled</span>
          </label>
          <label className="block">
            <span className="text-xs font-medium text-slate-600 dark:text-slate-300 mb-0.5 block">
              Daily execution cap (empty = unlimited)
            </span>
            <input
              type="number"
              min={1}
              value={draft.maxExecutionsPerDay ?? ''}
              onChange={(e) => {
                const v = e.target.value
                setDraft({
                  ...draft,
                  maxExecutionsPerDay: v === '' ? null : Number(v),
                })
              }}
              className="w-full h-7 px-2 text-xs border border-slate-200 dark:border-slate-700 dark:bg-slate-900 rounded tabular-nums"
            />
          </label>
        </section>

        {/* Footer */}
        <div className="flex items-center justify-between">
          <Button
            variant="secondary"
            size="sm"
            onClick={testInline}
            disabled={testing}
            loading={testing}
            title="Evaluate the rule against an empty sample context"
          >
            <TestTube className="w-3 h-3 mr-1" />
            Test
          </Button>
          {tested && (
            <span
              className={cn(
                'text-xs',
                tested.matched
                  ? 'text-emerald-700 dark:text-emerald-300'
                  : 'text-slate-500',
              )}
            >
              {tested.matched
                ? `would match · ${tested.actionsPreview.length} action${tested.actionsPreview.length === 1 ? '' : 's'} pending`
                : 'no match'}
            </span>
          )}
          <Button
            variant="primary"
            size="sm"
            onClick={save}
            disabled={!draft.name.trim() || saving}
            loading={saving}
          >
            <Save className="w-3 h-3 mr-1" />
            {editingId ? 'Update' : 'Save'}
          </Button>
        </div>
      </div>
    </div>
  )
}
