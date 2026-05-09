'use client'

import { useCallback, useEffect, useState } from 'react'
import {
  AlertCircle,
  CheckCircle2,
  Clock,
  Loader2,
  RefreshCw,
  XCircle,
} from 'lucide-react'
import { Badge } from '@/components/ui/Badge'
import { getBackendUrl } from '@/lib/backend-url'
import { cn } from '@/lib/utils'

// Mirrors GET /api/dashboard/cron-runs response.

interface LatestRun {
  jobName: string
  startedAt: string
  finishedAt: string | null
  status: 'RUNNING' | 'SUCCESS' | 'FAILED' | string
  errorMessage: string | null
  outputSummary: string | null
  triggeredBy: string
  durationMs: number | null
}

interface StaleRun {
  id: string
  jobName: string
  startedAt: string
  triggeredBy: string
}

interface FailureRun {
  id: string
  jobName: string
  startedAt: string
  finishedAt: string | null
  errorMessage: string | null
  triggeredBy: string
}

interface CronRunsResponse {
  latest: LatestRun[]
  staleRunning: StaleRun[]
  recentFailures: FailureRun[]
  generatedAt: string
}

function relativeTime(iso: string | null): string {
  if (!iso) return '—'
  const ms = Date.now() - new Date(iso).getTime()
  if (ms < 0) return 'just now'
  const sec = Math.floor(ms / 1000)
  if (sec < 60) return `${sec}s ago`
  const min = Math.floor(sec / 60)
  if (min < 60) return `${min}m ago`
  const hr = Math.floor(min / 60)
  if (hr < 24) return `${hr}h ago`
  const day = Math.floor(hr / 24)
  return `${day}d ago`
}

function formatDuration(ms: number | null): string {
  if (ms == null) return '—'
  if (ms < 1000) return `${ms}ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`
  return `${Math.floor(ms / 60_000)}m ${Math.floor((ms % 60_000) / 1000)}s`
}

function StatusIcon({ status }: { status: string }) {
  const cls = 'w-3.5 h-3.5'
  switch (status) {
    case 'SUCCESS':
      return <CheckCircle2 className={cn(cls, 'text-green-600 dark:text-green-400')} />
    case 'FAILED':
      return <XCircle className={cn(cls, 'text-red-600 dark:text-red-400')} />
    case 'RUNNING':
      return <Loader2 className={cn(cls, 'text-blue-600 dark:text-blue-400 animate-spin')} />
    default:
      return <Clock className={cn(cls, 'text-slate-400 dark:text-slate-500')} />
  }
}

function statusVariant(status: string): 'success' | 'danger' | 'info' | 'default' {
  switch (status) {
    case 'SUCCESS': return 'success'
    case 'FAILED': return 'danger'
    case 'RUNNING': return 'info'
    default: return 'default'
  }
}

export default function CronStatusPanel() {
  const [data, setData] = useState<CronRunsResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const fetchData = useCallback(async () => {
    try {
      setLoading(true)
      const res = await fetch(`${getBackendUrl()}/api/dashboard/cron-runs`, {
        cache: 'no-store',
      })
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        throw new Error(body.error ?? `HTTP ${res.status}`)
      }
      const json = await res.json()
      setData(json)
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    fetchData()
    const id = setInterval(fetchData, 30_000)
    return () => clearInterval(id)
  }, [fetchData])

  return (
    <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-lg overflow-hidden">
      <div className="px-4 py-3 flex items-center justify-between border-b border-slate-200 dark:border-slate-700">
        <div>
          <h3 className="text-lg font-semibold text-slate-900 dark:text-slate-100">Cron Jobs</h3>
          <p className="text-base text-slate-500 dark:text-slate-400 mt-0.5">
            Latest run per scheduled job · stale RUNNING flags + recent failures
          </p>
        </div>
        <button
          type="button"
          onClick={fetchData}
          disabled={loading}
          className="text-sm text-slate-500 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-100 inline-flex items-center gap-1 disabled:opacity-50"
        >
          <RefreshCw className={cn('w-3 h-3', loading && 'animate-spin')} />
          Refresh
        </button>
      </div>

      {error && (
        <div className="px-4 py-2 text-base text-red-700 dark:text-red-300 bg-red-50 dark:bg-red-950/40 border-b border-red-200 dark:border-red-900 inline-flex items-center gap-2">
          <AlertCircle className="w-3.5 h-3.5" />
          {error}
        </div>
      )}

      {loading && !data && (
        <div className="p-4 space-y-2">
          {[1, 2, 3, 4].map((i) => (
            <div key={i} className="h-10 bg-slate-50 dark:bg-slate-800 rounded animate-pulse" />
          ))}
        </div>
      )}

      {data && data.latest.length === 0 && (
        <div className="p-6 text-md text-slate-500 dark:text-slate-400 text-center">
          No cron runs recorded in the last 30 days. Crons that have been
          updated to use <code className="text-sm bg-slate-100 dark:bg-slate-800 px-1 py-0.5 rounded">recordCronRun()</code> will appear here on their next firing.
        </div>
      )}

      {data && data.staleRunning.length > 0 && (
        <div className="px-4 py-3 bg-amber-50 dark:bg-amber-950/40 border-b border-amber-200 dark:border-amber-900">
          <div className="text-base font-semibold text-amber-900 mb-1.5 inline-flex items-center gap-1.5">
            <AlertCircle className="w-3.5 h-3.5" />
            {data.staleRunning.length} stale RUNNING (likely crashed mid-run)
          </div>
          <div className="space-y-0.5">
            {data.staleRunning.map((s) => (
              <div key={s.id} className="text-sm text-amber-800">
                <span className="font-mono">{s.jobName}</span>
                <span className="text-amber-600 dark:text-amber-400"> · started {relativeTime(s.startedAt)}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {data && data.latest.length > 0 && (
        <div className="overflow-x-auto">
          <table className="w-full text-base">
            <thead className="bg-slate-50 dark:bg-slate-800 text-sm text-slate-600 dark:text-slate-400 border-b border-slate-200 dark:border-slate-700">
              <tr>
                <th className="text-left font-medium px-3 py-2">Job</th>
                <th className="text-left font-medium px-3 py-2 w-32">Status</th>
                <th className="text-left font-medium px-3 py-2 w-24">Last run</th>
                <th className="text-left font-medium px-3 py-2 w-24">Duration</th>
                <th className="text-left font-medium px-3 py-2">Output / Error</th>
              </tr>
            </thead>
            <tbody>
              {data.latest.map((r) => (
                <tr key={r.jobName} className="border-b border-slate-100 dark:border-slate-800 last:border-0 align-top">
                  <td className="px-3 py-2">
                    <div className="font-mono text-sm text-slate-900 dark:text-slate-100">{r.jobName}</div>
                    {r.triggeredBy === 'manual' && (
                      <div className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">manual trigger</div>
                    )}
                  </td>
                  <td className="px-3 py-2">
                    <Badge variant={statusVariant(r.status)} size="sm">
                      <StatusIcon status={r.status} />
                      {r.status}
                    </Badge>
                  </td>
                  <td className="px-3 py-2 text-sm text-slate-500 dark:text-slate-400" title={new Date(r.startedAt).toLocaleString()}>
                    {relativeTime(r.startedAt)}
                  </td>
                  <td className="px-3 py-2 text-sm text-slate-700 dark:text-slate-300 tabular-nums">
                    {formatDuration(r.durationMs)}
                  </td>
                  <td className="px-3 py-2">
                    {r.status === 'FAILED' && r.errorMessage ? (
                      <div className="text-sm text-red-700 dark:text-red-300 truncate" title={r.errorMessage}>
                        {r.errorMessage}
                      </div>
                    ) : r.outputSummary ? (
                      <div className="text-sm text-slate-600 dark:text-slate-400 truncate" title={r.outputSummary}>
                        {r.outputSummary}
                      </div>
                    ) : (
                      <span className="text-sm text-slate-400 dark:text-slate-500">—</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {data && data.recentFailures.length > 0 && (
        <div className="px-4 py-3 bg-red-50 dark:bg-red-950/40 border-t border-red-200 dark:border-red-900">
          <div className="text-base font-semibold text-red-900 dark:text-red-100 mb-1.5">
            Recent failures ({data.recentFailures.length})
          </div>
          <div className="space-y-1">
            {data.recentFailures.slice(0, 5).map((f) => (
              <div key={f.id} className="text-sm text-red-800">
                <span className="font-mono">{f.jobName}</span>
                <span className="text-red-600 dark:text-red-400"> · {relativeTime(f.startedAt)}</span>
                {f.errorMessage && (
                  <span className="text-red-700 dark:text-red-300"> · {f.errorMessage.slice(0, 100)}</span>
                )}
              </div>
            ))}
            {data.recentFailures.length > 5 && (
              <div className="text-xs text-red-600 dark:text-red-400 italic">
                +{data.recentFailures.length - 5} more
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
