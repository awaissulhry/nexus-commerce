// MC.11.3 — Cross-rule execution history.
//
// Server-rendered list of every AutomationRuleExecution row across
// every marketing-content rule. Default 100 rows, filterable by
// status. Links back to each rule's editor.

import Link from 'next/link'
import { ArrowLeft, History, AlertTriangle } from 'lucide-react'
import PageHeader from '@/components/layout/PageHeader'
import { getBackendUrl } from '@/lib/backend-url'

export const dynamic = 'force-dynamic'

interface ExecutionRow {
  id: string
  ruleId: string
  startedAt: string
  finishedAt: string | null
  durationMs: number | null
  status: string
  triggerData: unknown
  actionResults: unknown
  dryRun: boolean
  errorMessage: string | null
  rule: { id: string; name: string }
}

const STATUS_TONE: Record<string, string> = {
  SUCCESS:
    'bg-emerald-100 text-emerald-800 dark:bg-emerald-500/20 dark:text-emerald-300',
  PARTIAL:
    'bg-amber-100 text-amber-800 dark:bg-amber-500/20 dark:text-amber-300',
  FAILED:
    'bg-red-100 text-red-800 dark:bg-red-500/20 dark:text-red-300',
  DRY_RUN:
    'bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300',
  DEFERRED:
    'bg-blue-100 text-blue-800 dark:bg-blue-500/20 dark:text-blue-300',
}

async function fetchExecutions(): Promise<{
  executions: ExecutionRow[]
  error: string | null
}> {
  const backend = getBackendUrl()
  try {
    const res = await fetch(
      `${backend}/api/marketing-automation/executions?limit=200`,
      { cache: 'no-store' },
    )
    if (!res.ok)
      return {
        executions: [],
        error: `Executions API returned ${res.status}`,
      }
    const data = (await res.json()) as { executions: ExecutionRow[] }
    return { executions: data.executions, error: null }
  } catch (err) {
    return {
      executions: [],
      error: err instanceof Error ? err.message : 'Network error',
    }
  }
}

export default async function ExecutionHistoryPage() {
  const { executions, error } = await fetchExecutions()
  return (
    <div className="space-y-4">
      <Link
        href="/marketing/automation"
        className="inline-flex items-center gap-1 text-xs text-slate-500 hover:text-slate-700 dark:text-slate-400 dark:hover:text-slate-200"
      >
        <ArrowLeft className="w-3.5 h-3.5" />
        Back to Automation
      </Link>
      <PageHeader
        title="Execution history"
        description="Every rule firing across the marketing-content domain. Last 200."
      />

      {error && (
        <div
          role="alert"
          className="flex items-start gap-2 rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-900/20 dark:text-amber-200"
        >
          <AlertTriangle className="w-4 h-4 flex-shrink-0 mt-0.5" />
          <p>{error}</p>
        </div>
      )}

      {executions.length === 0 ? (
        <div className="flex flex-col items-center justify-center gap-2 rounded-lg border border-dashed border-slate-300 bg-white py-16 text-center dark:border-slate-700 dark:bg-slate-900">
          <History className="w-8 h-8 text-slate-400" />
          <p className="text-sm font-medium text-slate-900 dark:text-slate-100">
            No executions yet
          </p>
          <p className="max-w-md text-xs text-slate-500 dark:text-slate-400">
            Every rule firing — manual or auto-triggered — gets a row here.
            Hit the Run-now button on a rule to see what an execution looks like.
          </p>
        </div>
      ) : (
        <div className="overflow-hidden rounded-lg border border-slate-200 bg-white shadow-sm dark:border-slate-800 dark:bg-slate-900">
          <table className="w-full text-sm">
            <thead className="border-b border-slate-200 bg-slate-50 text-xs uppercase tracking-wide text-slate-500 dark:border-slate-800 dark:bg-slate-800/50 dark:text-slate-400">
              <tr>
                <th className="px-3 py-2 text-left font-semibold">Rule</th>
                <th className="px-3 py-2 text-left font-semibold">Status</th>
                <th className="px-3 py-2 text-left font-semibold">Started</th>
                <th className="px-3 py-2 text-right font-semibold">
                  Duration
                </th>
                <th className="px-3 py-2 text-left font-semibold">Detail</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
              {executions.map((exec) => (
                <tr key={exec.id}>
                  <td className="px-3 py-2">
                    <Link
                      href={`/marketing/automation`}
                      className="font-medium text-slate-900 hover:underline dark:text-slate-100"
                    >
                      {exec.rule.name}
                    </Link>
                    {exec.dryRun && (
                      <span className="ml-1 rounded bg-slate-100 px-1.5 py-0 text-[10px] font-medium uppercase tracking-wide text-slate-600 dark:bg-slate-800 dark:text-slate-300">
                        Dry run
                      </span>
                    )}
                  </td>
                  <td className="px-3 py-2">
                    <span
                      className={`inline-block rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${STATUS_TONE[exec.status] ?? 'bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300'}`}
                    >
                      {exec.status}
                    </span>
                  </td>
                  <td className="px-3 py-2 text-xs text-slate-600 dark:text-slate-400">
                    {new Date(exec.startedAt).toLocaleString()}
                  </td>
                  <td className="px-3 py-2 text-right text-xs text-slate-500 dark:text-slate-400">
                    {exec.durationMs != null
                      ? `${exec.durationMs} ms`
                      : '—'}
                  </td>
                  <td className="px-3 py-2 text-xs text-slate-600 dark:text-slate-400">
                    {exec.errorMessage ? (
                      <span className="text-red-600 dark:text-red-400">
                        {exec.errorMessage}
                      </span>
                    ) : (
                      <code className="text-[10px]">
                        {Array.isArray(exec.actionResults) &&
                        exec.actionResults[0]
                          ? (exec.actionResults[0] as { type?: string; reason?: string })
                              .reason ?? 'OK'
                          : '—'}
                      </code>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
