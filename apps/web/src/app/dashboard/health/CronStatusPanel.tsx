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
      return <CheckCircle2 className={cn(cls, 'text-green-600')} />
    case 'FAILED':
      return <XCircle className={cn(cls, 'text-red-600')} />
    case 'RUNNING':
      return <Loader2 className={cn(cls, 'text-blue-600 animate-spin')} />
    default:
      return <Clock className={cn(cls, 'text-slate-400')} />
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
    <div className="bg-white border border-slate-200 rounded-lg overflow-hidden">
      <div className="px-4 py-3 flex items-center justify-between border-b border-slate-200">
        <div>
          <h3 className="text-[14px] font-semibold text-slate-900">Cron Jobs</h3>
          <p className="text-[12px] text-slate-500 mt-0.5">
            Latest run per scheduled job · stale RUNNING flags + recent failures
          </p>
        </div>
        <button
          type="button"
          onClick={fetchData}
          disabled={loading}
          className="text-[11px] text-slate-500 hover:text-slate-900 inline-flex items-center gap-1 disabled:opacity-50"
        >
          <RefreshCw className={cn('w-3 h-3', loading && 'animate-spin')} />
          Refresh
        </button>
      </div>

      {error && (
        <div className="px-4 py-2 text-[12px] text-red-700 bg-red-50 border-b border-red-200 inline-flex items-center gap-2">
          <AlertCircle className="w-3.5 h-3.5" />
          {error}
        </div>
      )}

      {loading && !data && (
        <div className="p-4 space-y-2">
          {[1, 2, 3, 4].map((i) => (
            <div key={i} className="h-10 bg-slate-50 rounded animate-pulse" />
          ))}
        </div>
      )}

      {data && data.latest.length === 0 && (
        <div className="p-6 text-[13px] text-slate-500 text-center">
          No cron runs recorded in the last 30 days. Crons that have been
          updated to use <code className="text-[11px] bg-slate-100 px-1 py-0.5 rounded">recordCronRun()</code> will appear here on their next firing.
        </div>
      )}

      {data && data.staleRunning.length > 0 && (
        <div className="px-4 py-3 bg-amber-50 border-b border-amber-200">
          <div className="text-[12px] font-semibold text-amber-900 mb-1.5 inline-flex items-center gap-1.5">
            <AlertCircle className="w-3.5 h-3.5" />
            {data.staleRunning.length} stale RUNNING (likely crashed mid-run)
          </div>
          <div className="space-y-0.5">
            {data.staleRunning.map((s) => (
              <div key={s.id} className="text-[11px] text-amber-800">
                <span className="font-mono">{s.jobName}</span>
                <span className="text-amber-600"> · started {relativeTime(s.startedAt)}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {data && data.latest.length > 0 && (
        <div className="overflow-x-auto">
          <table className="w-full text-[12px]">
            <thead className="bg-slate-50 text-[11px] text-slate-600 border-b border-slate-200">
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
                <tr key={r.jobName} className="border-b border-slate-100 last:border-0 align-top">
                  <td className="px-3 py-2">
                    <div className="font-mono text-[11px] text-slate-900">{r.jobName}</div>
                    {r.triggeredBy === 'manual' && (
                      <div className="text-[10px] text-slate-500 mt-0.5">manual trigger</div>
                    )}
                  </td>
                  <td className="px-3 py-2">
                    <Badge variant={statusVariant(r.status)} size="sm">
                      <StatusIcon status={r.status} />
                      {r.status}
                    </Badge>
                  </td>
                  <td className="px-3 py-2 text-[11px] text-slate-500" title={new Date(r.startedAt).toLocaleString()}>
                    {relativeTime(r.startedAt)}
                  </td>
                  <td className="px-3 py-2 text-[11px] text-slate-700 tabular-nums">
                    {formatDuration(r.durationMs)}
                  </td>
                  <td className="px-3 py-2">
                    {r.status === 'FAILED' && r.errorMessage ? (
                      <div className="text-[11px] text-red-700 truncate" title={r.errorMessage}>
                        {r.errorMessage}
                      </div>
                    ) : r.outputSummary ? (
                      <div className="text-[11px] text-slate-600 truncate" title={r.outputSummary}>
                        {r.outputSummary}
                      </div>
                    ) : (
                      <span className="text-[11px] text-slate-400">—</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {data && data.recentFailures.length > 0 && (
        <div className="px-4 py-3 bg-red-50 border-t border-red-200">
          <div className="text-[12px] font-semibold text-red-900 mb-1.5">
            Recent failures ({data.recentFailures.length})
          </div>
          <div className="space-y-1">
            {data.recentFailures.slice(0, 5).map((f) => (
              <div key={f.id} className="text-[11px] text-red-800">
                <span className="font-mono">{f.jobName}</span>
                <span className="text-red-600"> · {relativeTime(f.startedAt)}</span>
                {f.errorMessage && (
                  <span className="text-red-700"> · {f.errorMessage.slice(0, 100)}</span>
                )}
              </div>
            ))}
            {data.recentFailures.length > 5 && (
              <div className="text-[10px] text-red-600 italic">
                +{data.recentFailures.length - 5} more
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
