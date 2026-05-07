'use client'

import { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import { Ban, Clock, Loader2 } from 'lucide-react'
import { Badge } from '@/components/ui/Badge'
import { getBackendUrl } from '@/lib/backend-url'
import { cn } from '@/lib/utils'

interface ActiveJob {
  id: string
  jobName: string
  actionType: string
  channel: string | null
  status: string
  totalItems: number
  processedItems: number
  failedItems: number
  skippedItems: number
  progressPercent: number
  createdAt: string
}

const POLL_INTERVAL_MS = 5_000

function formatActionType(t: string): string {
  return t
    .replace(/_/g, ' ')
    .toLowerCase()
    .replace(/\b\w/g, (c) => c.toUpperCase())
}

function StatusIcon({ status }: { status: string }) {
  switch (status) {
    case 'IN_PROGRESS':
      return <Loader2 className="w-3.5 h-3.5 text-blue-600 animate-spin" />
    case 'PENDING':
    case 'QUEUED':
    default:
      return <Clock className="w-3.5 h-3.5 text-blue-600" />
  }
}

/**
 * Compact strip of currently-running / queued bulk jobs. Shows above
 * the main /bulk-operations grid. Hides itself when there are no
 * active jobs — same UX pattern as Linear's active-issues bar.
 */
export default function ActiveJobsStrip() {
  const [jobs, setJobs] = useState<ActiveJob[]>([])
  const [error, setError] = useState<string | null>(null)
  const [cancellingId, setCancellingId] = useState<string | null>(null)

  const fetchActive = useCallback(async () => {
    try {
      const res = await fetch(
        `${getBackendUrl()}/api/bulk-operations/history?status=active&limit=10`,
        { cache: 'no-store' },
      )
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        throw new Error(body.error ?? `HTTP ${res.status}`)
      }
      const data = await res.json()
      setJobs(data.jobs ?? [])
      setError(null)
    } catch (err) {
      // Silent on poll failures — the strip just stays stale.
      // Surface only persistent errors via a one-line note.
      setError(err instanceof Error ? err.message : String(err))
    }
  }, [])

  useEffect(() => {
    fetchActive()
    const id = setInterval(fetchActive, POLL_INTERVAL_MS)
    return () => clearInterval(id)
  }, [fetchActive])

  const cancelJob = useCallback(
    async (jobId: string) => {
      setCancellingId(jobId)
      try {
        const res = await fetch(
          `${getBackendUrl()}/api/bulk-operations/${jobId}/cancel`,
          { method: 'POST' },
        )
        if (!res.ok) {
          const body = await res.json().catch(() => ({}))
          throw new Error(body.error ?? `HTTP ${res.status}`)
        }
        await fetchActive()
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err))
      } finally {
        setCancellingId(null)
      }
    },
    [fetchActive],
  )

  // Hide the strip entirely when there's nothing active. Same pattern
  // as Linear's active-issues bar — empty state lives at /history.
  if (jobs.length === 0 && !error) return null

  return (
    <div className="px-6 pb-2 flex-shrink-0">
      <div className="bg-blue-50 border border-blue-200 rounded-lg overflow-hidden">
        <div className="px-3 py-2 flex items-center justify-between border-b border-blue-200">
          <div className="text-sm font-semibold text-blue-900 uppercase tracking-wide">
            Active Jobs · {jobs.length}
          </div>
          <Link
            href="/bulk-operations/history"
            className="text-sm font-medium text-blue-700 hover:text-blue-900"
          >
            View all →
          </Link>
        </div>
        <div className="divide-y divide-blue-100">
          {jobs.map((job) => {
            const cancellable =
              job.status === 'PENDING' || job.status === 'QUEUED'
            const pct = Math.min(100, Math.max(0, job.progressPercent))
            return (
              <div
                key={job.id}
                className="px-3 py-2 flex items-center gap-3 hover:bg-blue-100/30 transition-colors"
              >
                <StatusIcon status={job.status} />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="text-base font-medium text-slate-900 truncate">
                      {job.jobName}
                    </span>
                    <Badge variant="info" size="sm">
                      {formatActionType(job.actionType)}
                    </Badge>
                    {job.channel && (
                      <Badge variant="default" size="sm">
                        {job.channel}
                      </Badge>
                    )}
                    <span className="text-xs text-slate-500 uppercase tracking-wide">
                      {job.status.replace(/_/g, ' ')}
                    </span>
                  </div>
                  {/* Progress bar — only meaningful while IN_PROGRESS;
                      for PENDING / QUEUED keep a flat indeterminate bar. */}
                  <div className="mt-1 flex items-center gap-2">
                    <div className="h-1 bg-blue-100 rounded-full overflow-hidden flex-1">
                      <div
                        className={cn(
                          'h-full rounded-full transition-all',
                          job.status === 'IN_PROGRESS'
                            ? 'bg-blue-600'
                            : 'bg-blue-300',
                        )}
                        style={{
                          width: job.status === 'IN_PROGRESS' ? `${pct}%` : '100%',
                        }}
                      />
                    </div>
                    <span className="text-xs text-slate-600 tabular-nums whitespace-nowrap">
                      {job.processedItems} / {job.totalItems}
                      {job.failedItems > 0 && (
                        <span className="text-red-700 ml-1">
                          · {job.failedItems} failed
                        </span>
                      )}
                    </span>
                  </div>
                </div>
                {cancellable && (
                  <button
                    type="button"
                    onClick={() => cancelJob(job.id)}
                    disabled={cancellingId === job.id}
                    className="flex-shrink-0 inline-flex items-center gap-1 px-2 py-1 text-sm text-red-700 hover:bg-red-50 rounded disabled:opacity-50"
                    title={`Cancel ${job.jobName}`}
                  >
                    <Ban className="w-3 h-3" />
                    {cancellingId === job.id ? 'Cancelling…' : 'Cancel'}
                  </button>
                )}
              </div>
            )
          })}
        </div>
        {error && (
          <div className="px-3 py-1.5 bg-red-50 border-t border-red-200 text-sm text-red-700">
            {error}
          </div>
        )}
      </div>
    </div>
  )
}
