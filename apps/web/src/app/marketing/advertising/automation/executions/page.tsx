/**
 * AD.3 — Execution feed for advertising-domain rules.
 *
 * Domain-filtered AutomationRuleExecution stream with status chips.
 * Expandable payload viewer per row.
 */

import Link from 'next/link'
import { History } from 'lucide-react'
import { AdvertisingNav } from '../../_shared/AdvertisingNav'
import { getBackendUrl } from '@/lib/backend-url'

export const dynamic = 'force-dynamic'

interface Execution {
  id: string
  ruleId: string
  triggerData: unknown
  actionResults: unknown
  dryRun: boolean
  status: string
  errorMessage: string | null
  startedAt: string
  finishedAt: string | null
  durationMs: number | null
  rule: { id: string; name: string; trigger: string } | null
}

async function fetchExecutions(): Promise<Execution[]> {
  const res = await fetch(
    `${getBackendUrl()}/api/advertising/automation-rule-executions?limit=200`,
    { cache: 'no-store' },
  )
  if (!res.ok) return []
  const json = (await res.json()) as { items: Execution[] }
  return json.items
}

const STATUS_CLASS: Record<string, string> = {
  SUCCESS: 'bg-emerald-50 text-emerald-700 ring-emerald-200 dark:bg-emerald-950/40 dark:text-emerald-300 dark:ring-emerald-900',
  DRY_RUN: 'bg-amber-50 text-amber-700 ring-amber-200 dark:bg-amber-950/40 dark:text-amber-300 dark:ring-amber-900',
  PARTIAL: 'bg-amber-50 text-amber-700 ring-amber-200 dark:bg-amber-950/40 dark:text-amber-300 dark:ring-amber-900',
  FAILED: 'bg-rose-50 text-rose-700 ring-rose-200 dark:bg-rose-950/40 dark:text-rose-300 dark:ring-rose-900',
  NO_MATCH: 'bg-slate-50 text-slate-500 ring-slate-200 dark:bg-slate-800 dark:text-slate-400 dark:ring-slate-700',
  CAP_EXCEEDED: 'bg-rose-50 text-rose-700 ring-rose-200 dark:bg-rose-950/40 dark:text-rose-300 dark:ring-rose-900',
}

export default async function ExecutionsPage() {
  const items = await fetchExecutions()
  const counts: Record<string, number> = {}
  for (const it of items) counts[it.status] = (counts[it.status] ?? 0) + 1

  return (
    <div className="px-4 py-4">
      <h1 className="text-xl font-semibold text-slate-900 dark:text-slate-100 flex items-center gap-2">
        <History className="h-5 w-5 text-slate-500" />
        Cronologia esecuzioni
      </h1>
      <p className="text-sm text-slate-500 dark:text-slate-400 mb-3">
        Ogni valutazione di regola advertising che ha matchato le condizioni produce un audit
        qui. NO_MATCH non viene registrato — solo le esecuzioni reali.
      </p>
      <AdvertisingNav />

      {Object.keys(counts).length > 0 && (
        <div className="flex items-center gap-2 flex-wrap mb-3">
          {Object.entries(counts).map(([status, n]) => (
            <span
              key={status}
              className={`text-[11px] uppercase tracking-wider px-2 py-0.5 rounded ring-1 ring-inset ${STATUS_CLASS[status] ?? 'bg-slate-50 ring-slate-200'}`}
            >
              {status}: {n}
            </span>
          ))}
        </div>
      )}

      <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-md overflow-hidden">
        {items.length === 0 ? (
          <div className="px-4 py-6 text-center text-sm text-slate-500">
            Nessuna esecuzione registrata. Esegui l&apos;evaluator dalla pagina automazione.
          </div>
        ) : (
          <ul className="divide-y divide-slate-200 dark:divide-slate-800">
            {items.map((ex) => (
              <li key={ex.id} className="px-3 py-2">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="font-mono text-xs text-slate-500 tabular-nums w-32">
                    {new Date(ex.startedAt).toLocaleString('it-IT', {
                      dateStyle: 'short',
                      timeStyle: 'short',
                    })}
                  </span>
                  <span
                    className={`text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded ring-1 ring-inset ${
                      STATUS_CLASS[ex.status] ?? 'bg-slate-50 ring-slate-200'
                    }`}
                  >
                    {ex.status}
                  </span>
                  {ex.rule && (
                    <Link
                      href={`/marketing/advertising/automation/${ex.rule.id}`}
                      className="text-sm text-blue-600 dark:text-blue-400 hover:underline truncate max-w-[300px]"
                    >
                      {ex.rule.name}
                    </Link>
                  )}
                  <span className="text-[10px] uppercase tracking-wider px-1 py-0.5 rounded bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-400">
                    {ex.rule?.trigger ?? '—'}
                  </span>
                  {ex.errorMessage && (
                    <span className="text-xs text-rose-700 dark:text-rose-300 truncate max-w-[300px]">
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
                  <pre className="mt-1 text-[11px] text-slate-600 dark:text-slate-400 overflow-auto max-h-[250px] bg-slate-50 dark:bg-slate-950/60 rounded p-2">
                    {JSON.stringify({ trigger: ex.triggerData, actions: ex.actionResults }, null, 2)}
                  </pre>
                </details>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  )
}
