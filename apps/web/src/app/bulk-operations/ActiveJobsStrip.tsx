'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import { Ban, Clock, Loader2 } from 'lucide-react'
import { Badge } from '@/components/ui/Badge'
import { useConfirm } from '@/components/ui/ConfirmProvider'
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
  estimatedCompletionAt?: string | null
}

/**
 * W10.2 — ETA chip helper. Renders a short relative time
 * ("~3m left", "~12m left", "~1h 4m left") from the projection
 * the API computes. Returns null until the projection has
 * settled (no items processed yet → no estimate possible).
 */
function formatEta(iso: string | null | undefined): string | null {
  if (!iso) return null
  const ms = new Date(iso).getTime() - Date.now()
  if (!Number.isFinite(ms) || ms <= 0) return null
  const totalSec = Math.round(ms / 1000)
  if (totalSec < 60) return `~${totalSec}s left`
  const min = Math.round(totalSec / 60)
  if (min < 60) return `~${min}m left`
  const h = Math.floor(min / 60)
  const remMin = min % 60
  return remMin === 0 ? `~${h}h left` : `~${h}h ${remMin}m left`
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
      return <Loader2 className="w-3.5 h-3.5 text-blue-600 dark:text-blue-400 animate-spin" />
    case 'CANCELLING':
      return <Loader2 className="w-3.5 h-3.5 text-amber-600 dark:text-amber-400 animate-spin" />
    case 'PENDING':
    case 'QUEUED':
    default:
      return <Clock className="w-3.5 h-3.5 text-blue-600 dark:text-blue-400" />
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
  const askConfirm = useConfirm()

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

  // W10.1 — Per-job SSE subscriptions. The list-level poll above
  // catches added/removed jobs (operator starts a new bulk action,
  // a queued job ages out); the SSE stream updates live progress for
  // each active row without forcing the strip to repoll every 5s.
  // On terminal status the server closes the stream — we refetch the
  // list once so the row drops off cleanly.
  const subsRef = useRef<Map<string, EventSource>>(new Map())
  useEffect(() => {
    if (typeof window === 'undefined' || typeof EventSource === 'undefined') return
    const subs = subsRef.current
    const wantedIds = new Set(jobs.map((j) => j.id))
    // Close subs for jobs no longer in the list
    for (const [id, es] of subs) {
      if (!wantedIds.has(id)) {
        es.close()
        subs.delete(id)
      }
    }
    // Open subs for new jobs
    for (const job of jobs) {
      if (subs.has(job.id)) continue
      const es = new EventSource(
        `${getBackendUrl()}/api/bulk-operations/${job.id}/events`,
      )
      es.addEventListener('update', (ev) => {
        try {
          const next = JSON.parse((ev as MessageEvent).data) as ActiveJob
          setJobs((prev) => prev.map((j) => (j.id === next.id ? { ...j, ...next } : j)))
        } catch {
          // Bad payload — ignore the tick.
        }
      })
      es.addEventListener('done', () => {
        es.close()
        subs.delete(job.id)
        // Refetch so terminal jobs drop off the strip.
        fetchActive()
      })
      es.onerror = () => {
        // EventSource auto-reconnects on transient drops; if it
        // settles into CLOSED the browser stops retrying. Either
        // way the next 5s list-poll will recreate the row.
      }
      subs.set(job.id, es)
    }
    return () => {
      // Don't close on every render — only on unmount. The cleanup
      // above (`!wantedIds.has`) handles removals between renders.
    }
  }, [jobs, fetchActive])

  useEffect(() => {
    // True unmount: close everything.
    const subs = subsRef.current
    return () => {
      for (const es of subs.values()) es.close()
      subs.clear()
    }
  }, [])

  const cancelJob = useCallback(
    async (job: ActiveJob) => {
      // W10.4 — confirm before cancelling. PENDING / QUEUED jobs
      // immediately go terminal (no work lost). IN_PROGRESS goes
      // CANCELLING + cooperatively exits between items, so partial
      // results stay on BulkActionItem. The confirm copy reflects
      // the difference so the operator knows what they're about to do.
      const inFlight = job.status === 'IN_PROGRESS'
      const ok = await askConfirm({
        title: `Cancel "${job.jobName}"?`,
        description: inFlight
          ? `${job.processedItems} of ${job.totalItems} items have already been written. Cancelling now stops the loop between items — the partial results stay in the audit trail.`
          : 'The job has not started yet — cancelling marks it CANCELLED immediately.',
        confirmLabel: 'Cancel job',
        cancelLabel: inFlight ? 'Keep running' : 'Keep queued',
        tone: 'warning',
      })
      if (!ok) return
      setCancellingId(job.id)
      try {
        const res = await fetch(
          `${getBackendUrl()}/api/bulk-operations/${job.id}/cancel`,
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
    [askConfirm, fetchActive],
  )

  // Hide the strip entirely when there's nothing active. Same pattern
  // as Linear's active-issues bar — empty state lives at /history.
  if (jobs.length === 0 && !error) return null

  return (
    <div className="px-6 pb-2 flex-shrink-0">
      <div className="bg-blue-50 dark:bg-blue-950/40 border border-blue-200 dark:border-blue-900 rounded-lg overflow-hidden">
        <div className="px-3 py-2 flex items-center justify-between border-b border-blue-200 dark:border-blue-900">
          <div className="text-sm font-semibold text-blue-900 dark:text-blue-200 uppercase tracking-wide">
            Active Jobs · {jobs.length}
          </div>
          <Link
            href="/bulk-operations/history"
            className="text-sm font-medium text-blue-700 dark:text-blue-300 hover:text-blue-900 dark:hover:text-blue-100"
          >
            View all →
          </Link>
        </div>
        <div className="divide-y divide-blue-100 dark:divide-blue-900/60">
          {jobs.map((job) => {
            // W1.1 — IN_PROGRESS jobs are now cooperatively cancellable;
            // the backend flips status → CANCELLING and the per-item
            // loop in BulkActionService.processJob exits between items.
            // CANCELLING shows the in-flight cancel without re-enabling
            // the button (avoids double-cancel races).
            const cancellable =
              job.status === 'PENDING' ||
              job.status === 'QUEUED' ||
              job.status === 'IN_PROGRESS'
            const pct = Math.min(100, Math.max(0, job.progressPercent))
            return (
              <div
                key={job.id}
                className="px-3 py-2 flex items-center gap-3 hover:bg-blue-100/30 dark:hover:bg-blue-900/30 transition-colors"
              >
                <StatusIcon status={job.status} />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="text-base font-medium text-slate-900 dark:text-slate-100 truncate">
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
                    <span className="text-xs text-slate-500 dark:text-slate-400 uppercase tracking-wide">
                      {job.status.replace(/_/g, ' ')}
                    </span>
                  </div>
                  {/* Progress bar — only meaningful while IN_PROGRESS;
                      for PENDING / QUEUED keep a flat indeterminate bar. */}
                  <div className="mt-1 flex items-center gap-2">
                    <div
                      className="h-1 bg-blue-100 dark:bg-blue-900/60 rounded-full overflow-hidden flex-1"
                      role="progressbar"
                      aria-label={`Progress for ${job.jobName}`}
                      aria-valuenow={pct}
                      aria-valuemin={0}
                      aria-valuemax={100}
                    >
                      <div
                        className={cn(
                          'h-full rounded-full transition-all',
                          job.status === 'IN_PROGRESS'
                            ? 'bg-blue-600 dark:bg-blue-700'
                            : 'bg-blue-300',
                        )}
                        style={{
                          width: job.status === 'IN_PROGRESS' ? `${pct}%` : '100%',
                        }}
                      />
                    </div>
                    <span
                      className="text-xs text-slate-600 dark:text-slate-400 tabular-nums whitespace-nowrap"
                      aria-live="polite"
                      aria-atomic="true"
                    >
                      {job.processedItems} / {job.totalItems}
                      {job.failedItems > 0 && (
                        <span className="text-red-700 dark:text-red-300 ml-1">
                          · {job.failedItems} failed
                        </span>
                      )}
                      {job.status === 'IN_PROGRESS' && formatEta(job.estimatedCompletionAt) && (
                        <span
                          className="ml-1 text-blue-700 dark:text-blue-300"
                          title={
                            job.estimatedCompletionAt
                              ? `Projected finish: ${new Date(job.estimatedCompletionAt).toLocaleString()}`
                              : undefined
                          }
                        >
                          · {formatEta(job.estimatedCompletionAt)}
                        </span>
                      )}
                    </span>
                  </div>
                </div>
                {cancellable && (
                  <button
                    type="button"
                    onClick={() => cancelJob(job)}
                    disabled={cancellingId === job.id}
                    className="flex-shrink-0 inline-flex items-center gap-1 px-2 py-1 text-sm text-red-700 dark:text-red-300 hover:bg-red-50 dark:hover:bg-red-950/40 rounded disabled:opacity-50"
                    title={`Cancel ${job.jobName}`}
                    aria-label={`Cancel ${job.jobName}`}
                  >
                    <Ban className="w-3 h-3" aria-hidden="true" />
                    {cancellingId === job.id ? 'Cancelling…' : 'Cancel'}
                  </button>
                )}
              </div>
            )
          })}
        </div>
        {error && (
          <div className="px-3 py-1.5 bg-red-50 dark:bg-red-950/40 border-t border-red-200 dark:border-red-900 text-sm text-red-700 dark:text-red-300">
            {error}
          </div>
        )}
      </div>
    </div>
  )
}
