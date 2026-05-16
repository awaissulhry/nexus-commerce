/**
 * AD.3 — Automation rule editor.
 *
 * Read-rendered with a client-side toggle for enabled + dryRun (no DSL
 * editor in AD.3 — operators clone templates and re-seed; the JSON
 * conditions/actions can be inspected here for review). AD.4+ adds an
 * inline conditions-tree editor.
 */

import Link from 'next/link'
import { notFound } from 'next/navigation'
import { ChevronLeft } from 'lucide-react'
import { AdvertisingNav } from '../../_shared/AdvertisingNav'
import { getBackendUrl } from '@/lib/backend-url'
import { RuleToggleClient } from './RuleToggleClient'

export const dynamic = 'force-dynamic'

interface Rule {
  id: string
  name: string
  description: string | null
  domain: string
  trigger: string
  conditions: unknown
  actions: unknown
  enabled: boolean
  dryRun: boolean
  scopeMarketplace: string | null
  maxExecutionsPerDay: number | null
  maxValueCentsEur: number | null
  maxDailyAdSpendCentsEur: number | null
  evaluationCount: number
  matchCount: number
  executionCount: number
  lastEvaluatedAt: string | null
  lastMatchedAt: string | null
  lastExecutedAt: string | null
}

async function fetchRule(id: string): Promise<Rule | null> {
  const res = await fetch(
    `${getBackendUrl()}/api/advertising/automation-rules/${id}`,
    { cache: 'no-store' },
  )
  if (!res.ok) return null
  const json = (await res.json()) as { rule: Rule }
  return json.rule
}

interface Execution {
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

async function fetchRecentExecutions(ruleId: string): Promise<Execution[]> {
  const res = await fetch(
    `${getBackendUrl()}/api/advertising/automation-rule-executions?ruleId=${ruleId}&limit=20`,
    { cache: 'no-store' },
  )
  if (!res.ok) return []
  const json = (await res.json()) as { items: Execution[] }
  return json.items
}

export default async function AutomationRuleDetailPage({
  params,
}: {
  params: { id: string }
}) {
  const rule = await fetchRule(params.id)
  if (!rule) notFound()
  const executions = await fetchRecentExecutions(rule.id)

  return (
    <div className="px-4 py-4">
      <div className="mb-2">
        <Link
          href="/marketing/advertising/automation"
          className="inline-flex items-center gap-1 text-xs text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-100"
        >
          <ChevronLeft className="h-3 w-3" /> Automation
        </Link>
      </div>
      <h1 className="text-xl font-semibold text-slate-900 dark:text-slate-100">{rule.name}</h1>
      <div className="text-xs text-slate-500 dark:text-slate-400 mb-3 flex items-center gap-2 flex-wrap">
        <span className="font-mono">{rule.trigger}</span>
        {rule.scopeMarketplace && (
          <>
            <span>·</span>
            <span className="font-mono">{rule.scopeMarketplace}</span>
          </>
        )}
        <span>·</span>
        <span>Evaluations {rule.evaluationCount}</span>
        <span>·</span>
        <span>Matches {rule.matchCount}</span>
        <span>·</span>
        <span>Executions {rule.executionCount}</span>
      </div>
      <AdvertisingNav />

      {rule.description && (
        <p className="text-sm text-slate-600 dark:text-slate-300 mb-4 leading-relaxed">
          {rule.description}
        </p>
      )}

      <RuleToggleClient
        ruleId={rule.id}
        initialEnabled={rule.enabled}
        initialDryRun={rule.dryRun}
      />

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-6">
        <section>
          <h2 className="text-sm font-medium text-slate-700 dark:text-slate-300 mb-2">
            Conditions
          </h2>
          <pre className="bg-slate-50 dark:bg-slate-950/60 border border-slate-200 dark:border-slate-800 rounded-md px-3 py-2 text-xs text-slate-700 dark:text-slate-300 overflow-auto max-h-[300px]">
            {JSON.stringify(rule.conditions, null, 2)}
          </pre>
        </section>
        <section>
          <h2 className="text-sm font-medium text-slate-700 dark:text-slate-300 mb-2">
            Actions
          </h2>
          <pre className="bg-slate-50 dark:bg-slate-950/60 border border-slate-200 dark:border-slate-800 rounded-md px-3 py-2 text-xs text-slate-700 dark:text-slate-300 overflow-auto max-h-[300px]">
            {JSON.stringify(rule.actions, null, 2)}
          </pre>
        </section>
      </div>

      <section className="mb-6">
        <h2 className="text-sm font-medium text-slate-700 dark:text-slate-300 mb-2">Limits</h2>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
          <Stat
            label="Max executions/d"
            value={rule.maxExecutionsPerDay != null ? String(rule.maxExecutionsPerDay) : 'unlimited'}
          />
          <Stat
            label="Cap value/execution"
            value={
              rule.maxValueCentsEur != null
                ? `€${(rule.maxValueCentsEur / 100).toFixed(0)}`
                : 'unlimited'
            }
          />
          <Stat
            label="Daily spend cap"
            value={
              rule.maxDailyAdSpendCentsEur != null
                ? `€${(rule.maxDailyAdSpendCentsEur / 100).toFixed(0)}`
                : 'unlimited'
            }
          />
        </div>
      </section>

      <section>
        <h2 className="text-sm font-medium text-slate-700 dark:text-slate-300 mb-2">
          Recent executions ({executions.length})
        </h2>
        <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-md">
          {executions.length === 0 ? (
            <div className="px-3 py-4 text-sm text-slate-500">
              No executions yet. Run the evaluator from the automation page.
            </div>
          ) : (
            <ul className="divide-y divide-slate-200 dark:divide-slate-800">
              {executions.map((ex) => {
                const cls =
                  ex.status === 'SUCCESS'
                    ? 'bg-emerald-50 text-emerald-700 ring-emerald-200 dark:bg-emerald-950/40 dark:text-emerald-300 dark:ring-emerald-900'
                    : ex.status === 'DRY_RUN'
                      ? 'bg-amber-50 text-amber-700 ring-amber-200 dark:bg-amber-950/40 dark:text-amber-300 dark:ring-amber-900'
                      : ex.status === 'NO_MATCH'
                        ? 'bg-slate-50 text-slate-500 ring-slate-200 dark:bg-slate-800 dark:text-slate-400 dark:ring-slate-700'
                        : 'bg-rose-50 text-rose-700 ring-rose-200 dark:bg-rose-950/40 dark:text-rose-300 dark:ring-rose-900'
                return (
                  <li key={ex.id} className="px-3 py-2">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="font-mono text-xs text-slate-500 tabular-nums w-32">
                        {new Date(ex.startedAt).toLocaleString('en-GB', {
                          dateStyle: 'short',
                          timeStyle: 'short',
                        })}
                      </span>
                      <span className={`text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded ring-1 ring-inset ${cls}`}>
                        {ex.status}
                      </span>
                      {ex.errorMessage && (
                        <span className="text-xs text-rose-700 dark:text-rose-300">
                          {ex.errorMessage}
                        </span>
                      )}
                      {ex.durationMs != null && (
                        <span className="ml-auto text-[11px] text-slate-500 dark:text-slate-400 tabular-nums">
                          {ex.durationMs}ms
                        </span>
                      )}
                    </div>
                    <details className="mt-1">
                      <summary className="text-[11px] text-slate-500 dark:text-slate-400 cursor-pointer">
                        Payload
                      </summary>
                      <pre className="mt-1 text-[11px] text-slate-600 dark:text-slate-400 overflow-auto max-h-[200px] bg-slate-50 dark:bg-slate-950/60 rounded p-2">
                        {JSON.stringify({ trigger: ex.triggerData, actions: ex.actionResults }, null, 2)}
                      </pre>
                    </details>
                  </li>
                )
              })}
            </ul>
          )}
        </div>
      </section>
    </div>
  )
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-md px-3 py-2">
      <div className="text-[10px] uppercase tracking-wider text-slate-500 dark:text-slate-400">
        {label}
      </div>
      <div className="text-base font-semibold text-slate-900 dark:text-slate-100 tabular-nums">
        {value}
      </div>
    </div>
  )
}
