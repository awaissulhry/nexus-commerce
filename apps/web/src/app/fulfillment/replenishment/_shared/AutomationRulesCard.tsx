'use client'

/**
 * W4.5 — Automation rules card.
 *
 * Lists every replenishment automation rule with:
 *   - name + description (truncated)
 *   - enabled toggle (one click to turn a rule on/off)
 *   - dry-run badge (so the operator sees side-effect status at a
 *     glance — green = real, slate = dry-run)
 *   - per-rule counters (matchCount / executionCount, last activity)
 *   - "Seed templates" button when no rules exist yet
 *
 * Sits alongside the pipeline health strip on /fulfillment/replenishment.
 * Click a rule → expands inline to show conditions + actions JSON
 * (read-only for now; the full visual builder lands in W4.5b).
 *
 * The card is silent when no rules exist + the operator hasn't
 * pressed Seed — keeps the workspace uncluttered for fresh installs.
 */

import { useCallback, useEffect, useState } from 'react'
import { Sparkles, Play, Pause, Loader2, Trash2, AlertOctagon, Zap, Settings } from 'lucide-react'
import { Modal, ModalFooter } from '@/components/ui/Modal'
import { Button } from '@/components/ui/Button'
import { useToast } from '@/components/ui/Toast'
import { useTranslations } from '@/lib/i18n/use-translations'
import { useConfirm } from '@/components/ui/ConfirmProvider'
import { getBackendUrl } from '@/lib/backend-url'
import { cn } from '@/lib/utils'

interface AutomationRule {
  id: string
  name: string
  description: string | null
  domain: string
  trigger: string
  conditions: unknown
  actions: unknown
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

interface RuleExecution {
  id: string
  triggerData: unknown
  actionResults: unknown
  dryRun: boolean
  status: string
  errorMessage: string | null
  startedAt: string
  finishedAt: string | null
  durationMs: number | null
}

const EXEC_STATUS_TONES: Record<string, string> = {
  SUCCESS:
    'bg-emerald-50 text-emerald-700 ring-emerald-200 dark:bg-emerald-950/40 dark:text-emerald-300 dark:ring-emerald-900',
  DRY_RUN:
    'bg-amber-50 text-amber-700 ring-amber-200 dark:bg-amber-950/40 dark:text-amber-300 dark:ring-amber-900',
  PARTIAL:
    'bg-amber-50 text-amber-700 ring-amber-200 dark:bg-amber-950/40 dark:text-amber-300 dark:ring-amber-900',
  FAILED:
    'bg-rose-50 text-rose-700 ring-rose-200 dark:bg-rose-950/40 dark:text-rose-300 dark:ring-rose-900',
  NO_MATCH:
    'bg-slate-50 text-slate-600 ring-slate-200 dark:bg-slate-900 dark:text-slate-400 dark:ring-slate-800',
  CAP_EXCEEDED:
    'bg-rose-50 text-rose-700 ring-rose-200 dark:bg-rose-950/40 dark:text-rose-300 dark:ring-rose-900',
}

function relativeTime(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime()
  if (ms < 60_000) return `${Math.max(1, Math.round(ms / 1000))}s ago`
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m ago`
  if (ms < 86_400_000) return `${Math.round(ms / 3_600_000)}h ago`
  return `${Math.round(ms / 86_400_000)}d ago`
}

export function AutomationRulesCard() {
  const { toast } = useToast()
  const { t } = useTranslations()
  const askConfirm = useConfirm()
  const [rules, setRules] = useState<AutomationRule[] | null>(null)
  const [loading, setLoading] = useState(true)
  const [seeding, setSeeding] = useState(false)
  const [running, setRunning] = useState(false)
  const [expandedId, setExpandedId] = useState<string | null>(null)
  const [busyIds, setBusyIds] = useState<Set<string>>(new Set())
  const [editingRule, setEditingRule] = useState<AutomationRule | null>(null)

  const fetchRules = useCallback(async () => {
    setLoading(true)
    try {
      const res = await fetch(
        `${getBackendUrl()}/api/fulfillment/replenishment/automation/rules?domain=replenishment`,
        { cache: 'no-store' },
      )
      if (res.ok) {
        const json = await res.json()
        setRules(json.rules ?? [])
      }
    } catch {
      // fail-soft — card hides
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void fetchRules()
  }, [fetchRules])

  const runEvaluatorNow = useCallback(async () => {
    setRunning(true)
    try {
      const res = await fetch(
        `${getBackendUrl()}/api/fulfillment/replenishment/automation/run`,
        { method: 'POST', cache: 'no-store' },
      )
      const json = await res.json().catch(() => ({}))
      if (!res.ok || !json.ok) {
        toast.error(t('replenishment.automation.toast.runFailed'))
      } else {
        toast.success(
          t('replenishment.automation.toast.runSuccess', {
            summary: json.summary ?? '',
          }),
        )
        await fetchRules()
      }
    } catch (err) {
      toast.error(
        t('replenishment.automation.toast.runError', {
          message: err instanceof Error ? err.message : String(err),
        }),
      )
    } finally {
      setRunning(false)
    }
  }, [fetchRules, t, toast])

  const emergencyDisableAll = useCallback(async () => {
    const ok = await askConfirm({
      title: t('replenishment.automation.confirm.killSwitchTitle'),
      description: t('replenishment.automation.confirm.killSwitchDescription'),
      confirmLabel: t('replenishment.automation.confirm.killSwitchConfirm'),
      tone: 'danger',
    })
    if (!ok) return
    try {
      const res = await fetch(
        `${getBackendUrl()}/api/fulfillment/replenishment/automation/emergency-disable-all`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ domain: 'replenishment' }),
          cache: 'no-store',
        },
      )
      const json = await res.json().catch(() => ({}))
      if (!res.ok) {
        toast.error(t('replenishment.automation.toast.killSwitchFailed'))
      } else {
        toast.success(
          t('replenishment.automation.toast.killSwitchSuccess', {
            count: json.disabledCount ?? 0,
          }),
        )
        await fetchRules()
      }
    } catch (err) {
      toast.error(
        t('replenishment.automation.toast.killSwitchError', {
          message: err instanceof Error ? err.message : String(err),
        }),
      )
    }
  }, [askConfirm, fetchRules, t, toast])

  const seedTemplates = useCallback(async () => {
    setSeeding(true)
    try {
      const res = await fetch(
        `${getBackendUrl()}/api/fulfillment/replenishment/automation/rules/seed-templates`,
        { method: 'POST', cache: 'no-store' },
      )
      const json = await res.json().catch(() => ({}))
      if (!res.ok) {
        toast.error(t('replenishment.automation.toast.seedFailed'))
      } else {
        toast.success(
          t('replenishment.automation.toast.seedSuccess', {
            created: json.created?.length ?? 0,
            skipped: json.skippedExisting?.length ?? 0,
          }),
        )
        await fetchRules()
      }
    } catch (err) {
      toast.error(
        t('replenishment.automation.toast.seedError', {
          message: err instanceof Error ? err.message : String(err),
        }),
      )
    } finally {
      setSeeding(false)
    }
  }, [fetchRules, t, toast])

  const setEnabled = useCallback(
    async (rule: AutomationRule, next: boolean) => {
      setBusyIds((s) => new Set(s).add(rule.id))
      try {
        const res = await fetch(
          `${getBackendUrl()}/api/fulfillment/replenishment/automation/rules/${rule.id}`,
          {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ enabled: next }),
            cache: 'no-store',
          },
        )
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        await fetchRules()
        toast.success(
          next
            ? t('replenishment.automation.toast.enabled', { name: rule.name })
            : t('replenishment.automation.toast.disabled', { name: rule.name }),
        )
      } catch (err) {
        toast.error(
          t('replenishment.automation.toast.toggleError', {
            message: err instanceof Error ? err.message : String(err),
          }),
        )
      } finally {
        setBusyIds((s) => {
          const next = new Set(s)
          next.delete(rule.id)
          return next
        })
      }
    },
    [fetchRules, t, toast],
  )

  const deleteRule = useCallback(
    async (rule: AutomationRule) => {
      const ok = await askConfirm({
        title: t('replenishment.automation.confirm.deleteTitle', { name: rule.name }),
        description: t('replenishment.automation.confirm.deleteDescription'),
        confirmLabel: t('replenishment.automation.confirm.deleteConfirm'),
        tone: 'danger',
      })
      if (!ok) return
      setBusyIds((s) => new Set(s).add(rule.id))
      try {
        const res = await fetch(
          `${getBackendUrl()}/api/fulfillment/replenishment/automation/rules/${rule.id}`,
          { method: 'DELETE', cache: 'no-store' },
        )
        if (!res.ok && res.status !== 204) throw new Error(`HTTP ${res.status}`)
        await fetchRules()
        toast.success(
          t('replenishment.automation.toast.deleted', { name: rule.name }),
        )
      } catch (err) {
        toast.error(
          t('replenishment.automation.toast.deleteError', {
            message: err instanceof Error ? err.message : String(err),
          }),
        )
      } finally {
        setBusyIds((s) => {
          const next = new Set(s)
          next.delete(rule.id)
          return next
        })
      }
    },
    [askConfirm, fetchRules, t, toast],
  )

  if (loading && !rules) {
    return (
      <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-md px-3 py-2 text-xs text-slate-500">
        {t('replenishment.automation.loading')}
      </div>
    )
  }

  // Empty state — pre-seed call to action
  if (!rules || rules.length === 0) {
    return (
      <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-md px-3 py-2.5 flex items-center gap-3 flex-wrap">
        <Sparkles
          className="h-4 w-4 text-slate-500 dark:text-slate-400"
          aria-hidden="true"
        />
        <div className="flex-1 min-w-0">
          <div className="text-sm font-medium text-slate-900 dark:text-slate-100">
            {t('replenishment.automation.empty.title')}
          </div>
          <div className="text-xs text-slate-500 dark:text-slate-400">
            {t('replenishment.automation.empty.subtitle')}
          </div>
        </div>
        <button
          type="button"
          onClick={() => void seedTemplates()}
          disabled={seeding}
          className="text-xs px-2.5 py-1 rounded ring-1 ring-inset bg-slate-900 dark:bg-slate-700 text-white hover:bg-slate-800 dark:hover:bg-slate-600 disabled:opacity-50 inline-flex items-center gap-1"
          aria-label={t('replenishment.automation.empty.seedAriaLabel')}
        >
          {seeding ? (
            <Loader2 className="h-3 w-3 animate-spin" aria-hidden="true" />
          ) : (
            <Sparkles className="h-3 w-3" aria-hidden="true" />
          )}
          {seeding
            ? t('replenishment.automation.empty.seeding')
            : t('replenishment.automation.empty.seedButton')}
        </button>
      </div>
    )
  }

  // Active state — list of rules
  const activeCount = rules.filter((r) => r.enabled).length
  const dryRunCount = rules.filter((r) => r.enabled && r.dryRun).length

  return (
    <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-md">
      <div className="px-3 py-2 border-b border-slate-200 dark:border-slate-800 flex items-center gap-2">
        <Sparkles
          className="h-4 w-4 text-slate-500 dark:text-slate-400"
          aria-hidden="true"
        />
        <div className="text-sm font-medium text-slate-900 dark:text-slate-100">
          {t('replenishment.automation.header.title')}
        </div>
        <div className="text-xs text-slate-500 dark:text-slate-400">
          {t('replenishment.automation.header.summary', {
            total: rules.length,
            active: activeCount,
            dryRun: dryRunCount,
          })}
        </div>
        <div className="ml-auto flex items-center gap-1.5">
          <button
            type="button"
            onClick={() => void seedTemplates()}
            disabled={seeding}
            className="text-xs px-2 py-1 rounded ring-1 ring-inset bg-white dark:bg-slate-800 text-slate-700 dark:text-slate-300 border border-slate-300 dark:border-slate-700 hover:bg-slate-50 dark:hover:bg-slate-700 disabled:opacity-50 inline-flex items-center gap-1"
          >
            {seeding ? (
              <Loader2 className="h-3 w-3 animate-spin" aria-hidden="true" />
            ) : (
              <Sparkles className="h-3 w-3" aria-hidden="true" />
            )}
            {t('replenishment.automation.header.reseedButton')}
          </button>
          {activeCount > 0 && (
            <button
              type="button"
              onClick={() => void runEvaluatorNow()}
              disabled={running}
              className="text-xs px-2 py-1 rounded ring-1 ring-inset bg-slate-900 dark:bg-slate-700 text-white hover:bg-slate-800 dark:hover:bg-slate-600 disabled:opacity-50 inline-flex items-center gap-1"
              title={t('replenishment.automation.runNowTooltip')}
              aria-label={t('replenishment.automation.runNowAriaLabel')}
            >
              {running ? (
                <Loader2 className="h-3 w-3 animate-spin" aria-hidden="true" />
              ) : (
                <Zap className="h-3 w-3" aria-hidden="true" />
              )}
              {running
                ? t('replenishment.automation.runningNow')
                : t('replenishment.automation.runNowButton')}
            </button>
          )}
          {activeCount > 0 && (
            <button
              type="button"
              onClick={() => void emergencyDisableAll()}
              className="text-xs px-2 py-1 rounded ring-1 ring-inset bg-rose-50 dark:bg-rose-950/40 text-rose-700 dark:text-rose-300 border border-rose-200 dark:border-rose-900 hover:bg-rose-100 dark:hover:bg-rose-950/60 inline-flex items-center gap-1"
              title={t('replenishment.automation.killSwitchTooltip')}
              aria-label={t('replenishment.automation.killSwitchAriaLabel')}
            >
              <AlertOctagon className="h-3 w-3" aria-hidden="true" />
              {t('replenishment.automation.killSwitchButton')}
            </button>
          )}
        </div>
      </div>

      <RuleEditModal
        rule={editingRule}
        onClose={() => setEditingRule(null)}
        onSaved={() => {
          setEditingRule(null)
          void fetchRules()
        }}
      />

      <ul className="divide-y divide-slate-200 dark:divide-slate-800">
        {rules.map((rule) => {
          const expanded = expandedId === rule.id
          const busy = busyIds.has(rule.id)
          return (
            <li key={rule.id}>
              <div className="px-3 py-2 flex items-start gap-3">
                <button
                  type="button"
                  onClick={() => void setEnabled(rule, !rule.enabled)}
                  disabled={busy}
                  className={cn(
                    'mt-0.5 h-7 w-7 rounded inline-flex items-center justify-center transition-colors',
                    rule.enabled
                      ? 'bg-emerald-50 text-emerald-700 ring-1 ring-emerald-200 hover:bg-emerald-100 dark:bg-emerald-950/40 dark:text-emerald-300 dark:ring-emerald-900'
                      : 'bg-slate-50 text-slate-500 ring-1 ring-slate-200 hover:bg-slate-100 dark:bg-slate-800 dark:text-slate-400 dark:ring-slate-700',
                    busy && 'opacity-50 cursor-not-allowed',
                  )}
                  title={
                    rule.enabled
                      ? t('replenishment.automation.toggle.disable')
                      : t('replenishment.automation.toggle.enable')
                  }
                  aria-label={
                    rule.enabled
                      ? t('replenishment.automation.toggle.disable')
                      : t('replenishment.automation.toggle.enable')
                  }
                  aria-pressed={rule.enabled}
                >
                  {busy ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
                  ) : rule.enabled ? (
                    <Play className="h-3.5 w-3.5" aria-hidden="true" />
                  ) : (
                    <Pause className="h-3.5 w-3.5" aria-hidden="true" />
                  )}
                </button>

                <div className="flex-1 min-w-0">
                  <button
                    type="button"
                    onClick={() => setExpandedId(expanded ? null : rule.id)}
                    className="text-left w-full"
                    aria-expanded={expanded}
                  >
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="text-sm font-medium text-slate-900 dark:text-slate-100">
                        {rule.name}
                      </span>
                      {rule.dryRun && (
                        <span
                          className="text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded ring-1 ring-inset bg-amber-50 text-amber-700 ring-amber-200 dark:bg-amber-950/40 dark:text-amber-300 dark:ring-amber-900"
                          title={t('replenishment.automation.dryRunTooltip')}
                        >
                          {t('replenishment.automation.dryRunBadge')}
                        </span>
                      )}
                      <span className="text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded ring-1 ring-inset bg-slate-50 text-slate-600 ring-slate-200 dark:bg-slate-800 dark:text-slate-400 dark:ring-slate-700">
                        {rule.trigger}
                      </span>
                    </div>
                    {rule.description && (
                      <div className="text-xs text-slate-500 dark:text-slate-400 mt-0.5 line-clamp-2">
                        {rule.description}
                      </div>
                    )}
                    <div className="text-[10px] text-slate-400 dark:text-slate-500 mt-1">
                      {t('replenishment.automation.counters', {
                        evals: rule.evaluationCount,
                        matches: rule.matchCount,
                        execs: rule.executionCount,
                      })}
                    </div>
                  </button>

                  {expanded && (
                    <>
                      <div className="mt-2 grid grid-cols-1 md:grid-cols-2 gap-2 text-xs">
                        <div>
                          <div className="text-[10px] uppercase tracking-wider text-slate-500 dark:text-slate-400 font-semibold mb-1">
                            {t('replenishment.automation.conditionsLabel')}
                          </div>
                          <pre className="bg-slate-50 dark:bg-slate-950 rounded p-2 overflow-x-auto text-[11px] text-slate-700 dark:text-slate-300">
                            {JSON.stringify(rule.conditions, null, 2)}
                          </pre>
                        </div>
                        <div>
                          <div className="text-[10px] uppercase tracking-wider text-slate-500 dark:text-slate-400 font-semibold mb-1">
                            {t('replenishment.automation.actionsLabel')}
                          </div>
                          <pre className="bg-slate-50 dark:bg-slate-950 rounded p-2 overflow-x-auto text-[11px] text-slate-700 dark:text-slate-300">
                            {JSON.stringify(rule.actions, null, 2)}
                          </pre>
                        </div>
                      </div>
                      <RecentExecutions ruleId={rule.id} />
                    </>
                  )}
                </div>

                <button
                  type="button"
                  onClick={() => setEditingRule(rule)}
                  className="h-7 w-7 inline-flex items-center justify-center text-slate-400 hover:text-blue-700 dark:hover:text-blue-400 hover:bg-blue-50 dark:hover:bg-blue-950/30 rounded"
                  title={t('replenishment.automation.editTooltip')}
                  aria-label={t('replenishment.automation.editAriaLabel', { name: rule.name })}
                >
                  <Settings className="h-3.5 w-3.5" aria-hidden="true" />
                </button>

                <button
                  type="button"
                  onClick={() => void deleteRule(rule)}
                  disabled={busy}
                  className="h-7 w-7 inline-flex items-center justify-center text-slate-400 hover:text-rose-700 dark:hover:text-rose-400 hover:bg-rose-50 dark:hover:bg-rose-950/30 rounded disabled:opacity-50"
                  title={t('replenishment.automation.deleteTooltip')}
                  aria-label={t('replenishment.automation.deleteAriaLabel', { name: rule.name })}
                >
                  <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
                </button>
              </div>
            </li>
          )
        })}
      </ul>
    </div>
  )
}

/**
 * W4.11 — recent executions panel inside the rule expand view.
 * Loads on first expand; ~50 newest first. Status pills colour-coded
 * via EXEC_STATUS_TONES (SUCCESS=green / DRY_RUN=amber / PARTIAL=
 * amber / FAILED=rose / NO_MATCH=slate / CAP_EXCEEDED=rose).
 *
 * Click an execution → expands the JSON triggerData + actionResults
 * inline so the operator can debug "why didn't this match?" without
 * leaving the workspace.
 */
function RecentExecutions({ ruleId }: { ruleId: string }) {
  const { t } = useTranslations()
  const [executions, setExecutions] = useState<RuleExecution[] | null>(null)
  const [loading, setLoading] = useState(true)
  const [openExecId, setOpenExecId] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    fetch(
      `${getBackendUrl()}/api/fulfillment/replenishment/automation/rules/${ruleId}/executions?limit=20`,
      { cache: 'no-store' },
    )
      .then((r) => (r.ok ? r.json() : null))
      .then((json) => {
        if (!cancelled) setExecutions(json?.executions ?? [])
      })
      .catch(() => {
        if (!cancelled) setExecutions([])
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [ruleId])

  return (
    <div className="mt-3">
      <div className="text-[10px] uppercase tracking-wider text-slate-500 dark:text-slate-400 font-semibold mb-1">
        {t('replenishment.automation.recentExecutions.title')}
      </div>
      {loading ? (
        <div className="text-xs text-slate-500 dark:text-slate-400">
          {t('replenishment.automation.recentExecutions.loading')}
        </div>
      ) : !executions || executions.length === 0 ? (
        <div className="text-xs text-slate-500 dark:text-slate-400 italic">
          {t('replenishment.automation.recentExecutions.empty')}
        </div>
      ) : (
        <ul className="space-y-1">
          {executions.map((exec) => {
            const tone = EXEC_STATUS_TONES[exec.status] ?? EXEC_STATUS_TONES.NO_MATCH
            const open = openExecId === exec.id
            return (
              <li
                key={exec.id}
                className="rounded border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-950/50"
              >
                <button
                  type="button"
                  onClick={() => setOpenExecId(open ? null : exec.id)}
                  className="w-full text-left px-2 py-1.5 flex items-center gap-2 flex-wrap"
                  aria-expanded={open}
                >
                  <span
                    className={cn(
                      'text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded ring-1 ring-inset font-medium',
                      tone,
                    )}
                  >
                    {exec.status}
                  </span>
                  {exec.dryRun && (
                    <span className="text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded ring-1 ring-inset bg-amber-50 text-amber-700 ring-amber-200 dark:bg-amber-950/40 dark:text-amber-300 dark:ring-amber-900">
                      {t('replenishment.automation.dryRunBadge')}
                    </span>
                  )}
                  <span className="text-[11px] text-slate-600 dark:text-slate-400">
                    {relativeTime(exec.startedAt)}
                  </span>
                  {exec.durationMs != null && (
                    <span className="text-[11px] text-slate-500 dark:text-slate-500">
                      · {exec.durationMs}ms
                    </span>
                  )}
                  {exec.errorMessage && (
                    <span className="text-[11px] text-rose-700 dark:text-rose-400 truncate">
                      · {exec.errorMessage}
                    </span>
                  )}
                </button>
                {open && (
                  <div className="px-2 pb-2 grid grid-cols-1 md:grid-cols-2 gap-2 text-[11px]">
                    <div>
                      <div className="text-[10px] uppercase tracking-wider text-slate-500 dark:text-slate-400 font-semibold mb-1">
                        {t('replenishment.automation.recentExecutions.triggerData')}
                      </div>
                      <pre className="bg-white dark:bg-slate-900 rounded p-2 overflow-x-auto text-[10px] text-slate-700 dark:text-slate-300 max-h-48">
                        {JSON.stringify(exec.triggerData, null, 2)}
                      </pre>
                    </div>
                    <div>
                      <div className="text-[10px] uppercase tracking-wider text-slate-500 dark:text-slate-400 font-semibold mb-1">
                        {t('replenishment.automation.recentExecutions.actionResults')}
                      </div>
                      <pre className="bg-white dark:bg-slate-900 rounded p-2 overflow-x-auto text-[10px] text-slate-700 dark:text-slate-300 max-h-48">
                        {JSON.stringify(exec.actionResults, null, 2)}
                      </pre>
                    </div>
                  </div>
                )}
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}

/**
 * W4.13 — Rule basics editor. Field-by-field form for the high-impact
 * tunables: name, description, dryRun toggle, maxExecutionsPerDay,
 * maxValueCentsEur. Conditions + actions JSON stay in the expand
 * view (read-only); a future commit lands drag-drop visual editing.
 *
 * Why these fields specifically: per the prompt's "operator can
 * tune thresholds without a code change", the most-frequently-edited
 * params are the spend caps + dry-run flag. Name + description help
 * operators clarify what a customised rule does once it diverges
 * from the seeded template.
 */
function RuleEditModal({
  rule,
  onClose,
  onSaved,
}: {
  rule: AutomationRule | null
  onClose: () => void
  onSaved: () => void
}) {
  const { t } = useTranslations()
  const { toast } = useToast()
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [dryRun, setDryRun] = useState(true)
  const [maxExecutionsPerDay, setMaxExecutionsPerDay] = useState<string>('')
  const [maxValueEur, setMaxValueEur] = useState<string>('') // EUR (not cents) for friendlier input
  const [submitting, setSubmitting] = useState(false)

  // Re-seed form whenever a different rule opens.
  useEffect(() => {
    if (!rule) return
    setName(rule.name)
    setDescription(rule.description ?? '')
    setDryRun(rule.dryRun)
    setMaxExecutionsPerDay(
      rule.maxExecutionsPerDay != null ? String(rule.maxExecutionsPerDay) : '',
    )
    setMaxValueEur(
      rule.maxValueCentsEur != null
        ? String(Math.round(rule.maxValueCentsEur / 100))
        : '',
    )
  }, [rule])

  if (!rule) return null

  const submit = async () => {
    if (!name.trim()) {
      toast.error(t('replenishment.automation.edit.nameRequired'))
      return
    }
    const data: Record<string, unknown> = {
      name: name.trim(),
      description: description.trim() || null,
      dryRun,
    }
    // Empty string => null (unlimited). Non-empty must parse to int.
    if (maxExecutionsPerDay.trim() === '') {
      data.maxExecutionsPerDay = null
    } else {
      const n = parseInt(maxExecutionsPerDay, 10)
      if (!Number.isFinite(n) || n < 0) {
        toast.error(t('replenishment.automation.edit.invalidExecCap'))
        return
      }
      data.maxExecutionsPerDay = n
    }
    if (maxValueEur.trim() === '') {
      data.maxValueCentsEur = null
    } else {
      const eur = parseFloat(maxValueEur)
      if (!Number.isFinite(eur) || eur < 0) {
        toast.error(t('replenishment.automation.edit.invalidValueCap'))
        return
      }
      data.maxValueCentsEur = Math.round(eur * 100)
    }
    setSubmitting(true)
    try {
      const res = await fetch(
        `${getBackendUrl()}/api/fulfillment/replenishment/automation/rules/${rule.id}`,
        {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(data),
          cache: 'no-store',
        },
      )
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        throw new Error(body.error ?? `HTTP ${res.status}`)
      }
      toast.success(t('replenishment.automation.edit.success', { name: name.trim() }))
      onSaved()
    } catch (err) {
      toast.error(
        t('replenishment.automation.edit.error', {
          message: err instanceof Error ? err.message : String(err),
        }),
      )
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Modal
      open={rule !== null}
      onClose={onClose}
      title={t('replenishment.automation.edit.title')}
      size="md"
    >
      <div className="space-y-3">
        <div>
          <label className="text-xs text-slate-500 dark:text-slate-400 font-medium block mb-1">
            {t('replenishment.automation.edit.nameLabel')}
          </label>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            autoFocus
            className="w-full text-sm rounded border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100 px-2 py-1.5 focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
        </div>
        <div>
          <label className="text-xs text-slate-500 dark:text-slate-400 font-medium block mb-1">
            {t('replenishment.automation.edit.descriptionLabel')}
          </label>
          <textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            rows={3}
            className="w-full text-sm rounded border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100 px-2 py-1.5 focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="text-xs text-slate-500 dark:text-slate-400 font-medium block mb-1">
              {t('replenishment.automation.edit.execCapLabel')}
            </label>
            <input
              type="number"
              min={0}
              value={maxExecutionsPerDay}
              onChange={(e) => setMaxExecutionsPerDay(e.target.value)}
              placeholder={t('replenishment.automation.edit.unlimitedPlaceholder')}
              className="w-full text-sm rounded border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100 px-2 py-1.5 focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
            <div className="text-[10px] text-slate-500 dark:text-slate-400 mt-1">
              {t('replenishment.automation.edit.execCapHint')}
            </div>
          </div>
          <div>
            <label className="text-xs text-slate-500 dark:text-slate-400 font-medium block mb-1">
              {t('replenishment.automation.edit.valueCapLabel')}
            </label>
            <input
              type="number"
              min={0}
              step="0.01"
              value={maxValueEur}
              onChange={(e) => setMaxValueEur(e.target.value)}
              placeholder={t('replenishment.automation.edit.unlimitedPlaceholder')}
              className="w-full text-sm rounded border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100 px-2 py-1.5 focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
            <div className="text-[10px] text-slate-500 dark:text-slate-400 mt-1">
              {t('replenishment.automation.edit.valueCapHint')}
            </div>
          </div>
        </div>
        <div className="flex items-center gap-2 pt-1">
          <input
            id="rule-dryrun"
            type="checkbox"
            checked={dryRun}
            onChange={(e) => setDryRun(e.target.checked)}
            className="rounded"
          />
          <label
            htmlFor="rule-dryrun"
            className="text-sm text-slate-700 dark:text-slate-300"
          >
            {t('replenishment.automation.edit.dryRunLabel')}
          </label>
        </div>
        <div className="text-[10px] text-slate-500 dark:text-slate-400">
          {t('replenishment.automation.edit.dryRunHint')}
        </div>
      </div>
      <ModalFooter>
        <Button onClick={onClose}>{t('common.cancel')}</Button>
        <Button
          variant="primary"
          onClick={() => void submit()}
          loading={submitting}
        >
          {t('replenishment.automation.edit.submit')}
        </Button>
      </ModalFooter>
    </Modal>
  )
}
