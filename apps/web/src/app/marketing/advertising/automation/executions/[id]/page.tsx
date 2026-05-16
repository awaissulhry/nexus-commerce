/**
 * AD.4 — Execution detail with per-action timeline + Rollback.
 *
 * Reads /api/advertising/actions/:executionId/log to surface every
 * AdvertisingActionLog row tied to the execution (matched by
 * executionId or by userId+createdAt window). Rollback button is only
 * shown for executions within the 24h window.
 */

import Link from 'next/link'
import { notFound } from 'next/navigation'
import { ChevronLeft, History } from 'lucide-react'
import { AdvertisingNav } from '../../../_shared/AdvertisingNav'
import { WriteModeBanner } from '../../../_shared/WriteModeBanner'
import { RollbackButton } from './RollbackButton'
import { getBackendUrl } from '@/lib/backend-url'

export const dynamic = 'force-dynamic'

interface ExecutionLog {
  id: string
  executionId: string | null
  userId: string | null
  actionType: string
  entityType: string
  entityId: string
  payloadBefore: unknown
  payloadAfter: unknown
  outboundQueueId: string | null
  amazonResponseId: string | null
  amazonResponseStatus: string | null
  rolledBackAt: string | null
  rollbackReason: string | null
  createdAt: string
}

interface LogResponse {
  items: ExecutionLog[]
  count: number
  executionStartedAt: string
}

async function fetchLog(executionId: string): Promise<LogResponse | null> {
  const res = await fetch(
    `${getBackendUrl()}/api/advertising/actions/${executionId}/log`,
    { cache: 'no-store' },
  )
  if (!res.ok) return null
  return (await res.json()) as LogResponse
}

const STATUS_TONE: Record<string, string> = {
  SUCCESS: 'text-emerald-700 dark:text-emerald-300',
  PENDING: 'text-amber-700 dark:text-amber-300',
  FAILED: 'text-rose-700 dark:text-rose-300',
}

export default async function ExecutionDetailPage({
  params,
}: {
  params: { id: string }
}) {
  const log = await fetchLog(params.id)
  if (!log) notFound()

  const startedAt = new Date(log.executionStartedAt)
  const within24h = Date.now() - startedAt.getTime() < 24 * 60 * 60 * 1000
  const reversible = log.items.filter((it) => it.rolledBackAt == null)
  const alreadyRolledBack = log.items.filter((it) => it.rolledBackAt != null)

  return (
    <div className="px-4 py-4">
      <div className="mb-2">
        <Link
          href="/marketing/advertising/automation/executions"
          className="inline-flex items-center gap-1 text-xs text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-100"
        >
          <ChevronLeft className="h-3 w-3" /> Executions
        </Link>
      </div>
      <h1 className="text-xl font-semibold text-slate-900 dark:text-slate-100 flex items-center gap-2">
        <History className="h-5 w-5 text-slate-500" />
        Execution {params.id.slice(0, 8)}
      </h1>
      <div className="text-xs text-slate-500 dark:text-slate-400 mb-3 flex items-center gap-2 flex-wrap">
        <span>
          {startedAt.toLocaleString('en-GB', { dateStyle: 'short', timeStyle: 'short' })}
        </span>
        <span>·</span>
        <span>{log.count} actions recorded</span>
        {!within24h && (
          <>
            <span>·</span>
            <span className="text-rose-700 dark:text-rose-300">rollback window expired (24h)</span>
          </>
        )}
      </div>
      <AdvertisingNav />

      <WriteModeBanner />

      {reversible.length > 0 && within24h && (
        <div className="mb-4">
          <RollbackButton executionId={params.id} count={reversible.length} />
        </div>
      )}

      {alreadyRolledBack.length > 0 && (
        <div className="mb-3 bg-blue-50 dark:bg-blue-950/40 border border-blue-200 dark:border-blue-900 rounded-md px-3 py-2 text-xs text-blue-900 dark:text-blue-100">
          {alreadyRolledBack.length} actions already rolled back. See below.
        </div>
      )}

      {log.items.length === 0 ? (
        <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-md px-4 py-6 text-center text-sm text-slate-500">
          No actions recorded for this execution.
        </div>
      ) : (
        <ol className="space-y-2">
          {log.items.map((it, i) => (
            <li
              key={it.id}
              className={`bg-white dark:bg-slate-900 border rounded-md ${
                it.rolledBackAt
                  ? 'border-slate-300 dark:border-slate-700 opacity-60'
                  : 'border-slate-200 dark:border-slate-800'
              }`}
            >
              <div className="px-3 py-2 border-b border-slate-200 dark:border-slate-800 flex items-center gap-2 flex-wrap">
                <span className="font-mono text-xs text-slate-500 w-6">#{i + 1}</span>
                <span className="text-sm font-medium text-slate-900 dark:text-slate-100">
                  {it.actionType}
                </span>
                <span className="text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded ring-1 ring-inset bg-slate-50 text-slate-600 ring-slate-200 dark:bg-slate-800 dark:text-slate-400 dark:ring-slate-700">
                  {it.entityType}
                </span>
                <span className="font-mono text-[11px] text-slate-500 truncate max-w-[200px]">
                  {it.entityId}
                </span>
                {it.amazonResponseStatus && (
                  <span className={`text-[11px] ${STATUS_TONE[it.amazonResponseStatus] ?? 'text-slate-500'}`}>
                    {it.amazonResponseStatus}
                  </span>
                )}
                {it.rolledBackAt && (
                  <span className="ml-auto text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded ring-1 ring-inset bg-blue-50 text-blue-700 ring-blue-200 dark:bg-blue-950/40 dark:text-blue-300 dark:ring-blue-900">
                    rolled-back
                  </span>
                )}
                <span className={`text-[11px] text-slate-500 ${it.rolledBackAt ? '' : 'ml-auto'}`}>
                  {new Date(it.createdAt).toLocaleTimeString('en-GB', {
                    hour: '2-digit',
                    minute: '2-digit',
                    second: '2-digit',
                  })}
                </span>
              </div>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-0 divide-y md:divide-y-0 md:divide-x divide-slate-200 dark:divide-slate-800">
                <div className="p-2">
                  <div className="text-[10px] uppercase tracking-wider text-slate-500 mb-1">Before</div>
                  <pre className="text-[11px] text-slate-700 dark:text-slate-300 bg-slate-50 dark:bg-slate-950/60 rounded p-2 overflow-auto max-h-[200px]">
                    {JSON.stringify(it.payloadBefore, null, 2)}
                  </pre>
                </div>
                <div className="p-2">
                  <div className="text-[10px] uppercase tracking-wider text-slate-500 mb-1">After</div>
                  <pre className="text-[11px] text-slate-700 dark:text-slate-300 bg-slate-50 dark:bg-slate-950/60 rounded p-2 overflow-auto max-h-[200px]">
                    {JSON.stringify(it.payloadAfter, null, 2)}
                  </pre>
                </div>
              </div>
              {it.rollbackReason && (
                <div className="px-3 py-1.5 text-[11px] text-blue-700 dark:text-blue-300 bg-blue-50 dark:bg-blue-950/40 border-t border-blue-200 dark:border-blue-900">
                  Rollback: {it.rollbackReason}
                </div>
              )}
            </li>
          ))}
        </ol>
      )}
    </div>
  )
}
