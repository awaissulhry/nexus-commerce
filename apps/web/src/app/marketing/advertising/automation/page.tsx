/**
 * AD.3 — Advertising automation rules workspace.
 *
 * Lists every AutomationRule with domain='advertising', shows status
 * (ENABLED / DRY_RUN / DISABLED) + last execution. Provides:
 *   - "Seed templates" button (idempotent, first-time setup)
 *   - "Test run evaluator" button (manual cron tick)
 *   - Link to execution feed
 *   - Per-rule edit link
 */

import Link from 'next/link'
import { AlertCircle, Bot, History, ChevronRight } from 'lucide-react'
import { AdvertisingNav } from '../_shared/AdvertisingNav'
import { getBackendUrl } from '@/lib/backend-url'
import { AutomationActionsClient } from './AutomationActionsClient'

export const dynamic = 'force-dynamic'

interface AutomationRule {
  id: string
  name: string
  description: string | null
  trigger: string
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

async function fetchRules(): Promise<AutomationRule[]> {
  const res = await fetch(
    `${getBackendUrl()}/api/advertising/automation-rules`,
    { cache: 'no-store' },
  )
  if (!res.ok) return []
  const json = (await res.json()) as { items: AutomationRule[] }
  return json.items
}

function statusLabel(rule: AutomationRule): { label: string; cls: string } {
  if (!rule.enabled) {
    return {
      label: 'Disabilitata',
      cls: 'bg-slate-50 text-slate-500 ring-slate-200 dark:bg-slate-800 dark:text-slate-400 dark:ring-slate-700',
    }
  }
  if (rule.dryRun) {
    return {
      label: 'Dry-run',
      cls: 'bg-amber-50 text-amber-700 ring-amber-200 dark:bg-amber-950/40 dark:text-amber-300 dark:ring-amber-900',
    }
  }
  return {
    label: 'Live',
    cls: 'bg-emerald-50 text-emerald-700 ring-emerald-200 dark:bg-emerald-950/40 dark:text-emerald-300 dark:ring-emerald-900',
  }
}

const TRIGGER_LABEL: Record<string, string> = {
  FBA_AGE_THRESHOLD_REACHED: 'Stock invecchiato FBA',
  AD_SPEND_PROFITABILITY_BREACH: 'Spesa > profitto',
  CAC_SPIKE: 'ACOS spike',
  AD_TARGET_UNDERPERFORMING: 'Target non redditizio',
}

export default async function AutomationPage() {
  const rules = await fetchRules()
  const live = rules.filter((r) => r.enabled && !r.dryRun).length
  const dryRun = rules.filter((r) => r.enabled && r.dryRun).length

  return (
    <div className="px-4 py-4">
      <h1 className="text-xl font-semibold text-slate-900 dark:text-slate-100 flex items-center gap-2">
        <Bot className="h-5 w-5 text-blue-500" />
        Automazione pubblicitaria
      </h1>
      <p className="text-sm text-slate-500 dark:text-slate-400 mb-3">
        Regole del motore AutomationRule (dominio &quot;advertising&quot;). Ogni regola
        di default parte disabilitata + dry-run; l&apos;operatore deve abilitarla
        esplicitamente. Cap giornaliero anti-runaway su ogni regola che spende.
      </p>
      <AdvertisingNav />

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-4">
        <Stat label="Regole" value={rules.length} />
        <Stat label="Live" value={live} tone={live > 0 ? 'emerald' : 'slate'} />
        <Stat label="Dry-run" value={dryRun} tone="amber" />
        <Stat label="Disabilitate" value={rules.length - live - dryRun} tone="slate" />
      </div>

      <AutomationActionsClient hasRules={rules.length > 0} />

      <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-md overflow-hidden">
        {rules.length === 0 ? (
          <div className="px-4 py-6 text-center text-sm text-slate-500">
            Nessuna regola ancora. Clicca <strong>Carica template</strong> qui sopra per
            seed-are i 5 modelli di partenza (Italian-first, dry-run di default).
          </div>
        ) : (
          <ul className="divide-y divide-slate-200 dark:divide-slate-800">
            {rules.map((r) => {
              const s = statusLabel(r)
              return (
                <li key={r.id}>
                  <Link
                    href={`/marketing/advertising/automation/${r.id}`}
                    className="block px-4 py-3 hover:bg-slate-50 dark:hover:bg-slate-950/40"
                  >
                    <div className="flex items-start gap-3">
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className="text-sm font-medium text-slate-900 dark:text-slate-100">
                            {r.name}
                          </span>
                          <span
                            className={`text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded ring-1 ring-inset ${s.cls}`}
                          >
                            {s.label}
                          </span>
                          <span className="text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded ring-1 ring-inset bg-slate-50 text-slate-600 ring-slate-200 dark:bg-slate-800 dark:text-slate-400 dark:ring-slate-700">
                            {TRIGGER_LABEL[r.trigger] ?? r.trigger}
                          </span>
                          {r.scopeMarketplace && (
                            <span className="text-[10px] font-mono px-1.5 py-0.5 rounded ring-1 ring-inset bg-blue-50 text-blue-700 ring-blue-200 dark:bg-blue-950/40 dark:text-blue-300 dark:ring-blue-900">
                              {r.scopeMarketplace}
                            </span>
                          )}
                        </div>
                        {r.description && (
                          <p className="text-xs text-slate-500 dark:text-slate-400 mt-1 line-clamp-2">
                            {r.description}
                          </p>
                        )}
                        <div className="text-[11px] text-slate-500 dark:text-slate-400 mt-1 flex items-center gap-3 flex-wrap">
                          <span>
                            Valutazioni {r.evaluationCount} · Match {r.matchCount} · Esecuzioni{' '}
                            {r.executionCount}
                          </span>
                          {r.lastExecutedAt && (
                            <span>
                              Ultima esecuzione{' '}
                              {new Date(r.lastExecutedAt).toLocaleString('it-IT', {
                                month: '2-digit',
                                day: '2-digit',
                                hour: '2-digit',
                                minute: '2-digit',
                              })}
                            </span>
                          )}
                          {r.maxDailyAdSpendCentsEur != null && (
                            <span>
                              Cap giornaliero €{(r.maxDailyAdSpendCentsEur / 100).toFixed(0)}
                            </span>
                          )}
                        </div>
                      </div>
                      <ChevronRight
                        className="h-4 w-4 text-slate-400 dark:text-slate-600 mt-1"
                        aria-hidden="true"
                      />
                    </div>
                  </Link>
                </li>
              )
            })}
          </ul>
        )}
      </div>

      <div className="mt-4 flex items-center gap-3 text-xs">
        <Link
          href="/marketing/advertising/automation/executions"
          className="inline-flex items-center gap-1 text-blue-600 dark:text-blue-400 hover:underline"
        >
          <History className="h-3 w-3" />
          Cronologia esecuzioni
        </Link>
      </div>

      <div className="mt-6 bg-amber-50 dark:bg-amber-950/40 border border-amber-200 dark:border-amber-900 rounded-md px-3 py-2 flex items-start gap-2">
        <AlertCircle className="h-4 w-4 text-amber-600 dark:text-amber-400 mt-0.5" aria-hidden="true" />
        <div className="text-xs text-amber-900 dark:text-amber-100 leading-relaxed">
          <strong>Modalità dry-run</strong> attiva di default per ogni nuova regola.
          Per passare in live: apri la regola → toggle Dry-run off → assicurati che il cron
          sia attivo (<code className="px-1 py-0.5 rounded bg-amber-100 dark:bg-amber-900/50">NEXUS_ENABLE_AMAZON_ADS_CRON=1</code>).
          AD.4 aggiunge la verifica two-key per le scritture live verso Amazon Ads API.
        </div>
      </div>
    </div>
  )
}

function Stat({
  label,
  value,
  tone,
}: {
  label: string
  value: number
  tone?: 'emerald' | 'amber' | 'slate'
}) {
  const valueClass =
    tone === 'emerald'
      ? 'text-emerald-700 dark:text-emerald-300'
      : tone === 'amber'
        ? 'text-amber-700 dark:text-amber-300'
        : 'text-slate-900 dark:text-slate-100'
  return (
    <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-md px-3 py-2">
      <div className="text-[10px] uppercase tracking-wider text-slate-500 dark:text-slate-400">
        {label}
      </div>
      <div className={`text-base font-semibold tabular-nums ${valueClass}`}>{value}</div>
    </div>
  )
}
