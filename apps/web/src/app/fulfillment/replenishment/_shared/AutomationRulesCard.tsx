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
import { Sparkles, Play, Pause, Loader2, Trash2, AlertOctagon, Zap } from 'lucide-react'
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
                  )}
                </div>

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
