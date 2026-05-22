// P-RT.9 — ambient bulk-operation progress banner.
//
// Subscribes to listing-events SSE for bulk.progress / bulk.completed.
// Any active bulk job (started in this tab OR another) shows a sticky
// strip at the top of the workspace with "Bulk update: 42/150 (28%)
// — 2 failed". On bulk.completed the row drops out of the live map
// and a one-shot toast confirms the outcome.
//
// Why this isn't /api/bulk-operations/:id/events
// ----------------------------------------------
// The per-job SSE endpoint is the right tool when an operator is on
// the bulk-job detail view and wants live updates for THAT job. This
// component is the "ambient awareness" version — show me what's
// running across the whole catalog without me opening a detail page.
// Bus events are tiny ({jobId, processed, total, ts}) — the wire cost
// is negligible even with multiple jobs in flight.

'use client'

import { useEffect, useState } from 'react'
import { useListingEvents } from '@/lib/sync/use-listing-events'
import { useToast } from '@/components/ui/Toast'
import { useTranslations } from '@/lib/i18n/use-translations'

interface ActiveJob {
  jobId: string
  processed: number
  total: number
  succeeded: number
  failed: number
  ts: number
}

export function BulkProgressBanner() {
  const { lastEvent } = useListingEvents()
  const { toast } = useToast()
  const { t } = useTranslations()
  const [activeJobs, setActiveJobs] = useState<Record<string, ActiveJob>>({})

  useEffect(() => {
    if (!lastEvent) return
    const e = lastEvent
    if (e.type === 'bulk.progress' && e.jobId) {
      // Update or insert. Only accept newer ts so stale events don't
      // overwrite a more recent reading (rare but bus is unordered).
      setActiveJobs((prev) => {
        const existing = prev[e.jobId!]
        if (existing && existing.ts > (e.ts ?? 0)) return prev
        return {
          ...prev,
          [e.jobId!]: {
            jobId: e.jobId!,
            processed: e.processed ?? 0,
            total: e.total ?? 0,
            succeeded: e.succeeded ?? 0,
            failed: e.failed ?? 0,
            ts: e.ts ?? Date.now(),
          },
        }
      })
    } else if (e.type === 'bulk.completed' && e.jobId) {
      // Drop from active map + toast the outcome. We don't have the
      // full final tallies on this event (the bus payload is minimal
      // to keep wire chatter low); the toast wording is intentionally
      // generic — operators can click into /bulk-operations for the
      // breakdown.
      setActiveJobs((prev) => {
        if (!prev[e.jobId!]) return prev
        const next = { ...prev }
        delete next[e.jobId!]
        return next
      })
      const status = e.status ?? 'COMPLETED'
      if (status === 'COMPLETED') {
        toast.success(t('products.bulk.completed.success'))
      } else if (status === 'PARTIALLY_COMPLETED') {
        toast.info(t('products.bulk.completed.partial'))
      } else if (status === 'FAILED') {
        toast.error(t('products.bulk.completed.failed'))
      } else if (status === 'CANCELLED') {
        toast.info(t('products.bulk.completed.cancelled'))
      }
    }
  }, [lastEvent, toast, t])

  const jobs = Object.values(activeJobs)
  if (jobs.length === 0) return null

  return (
    <div
      className="flex flex-col gap-1 px-3 py-2 border border-sky-200 bg-sky-50 dark:border-sky-800 dark:bg-sky-950/30 rounded-md"
      role="status"
      aria-live="polite"
      data-testid="bulk-progress-banner"
    >
      {jobs.map((j) => {
        const pct = j.total > 0 ? Math.round((j.processed / j.total) * 100) : 0
        return (
          <div key={j.jobId} className="flex items-center gap-3 text-xs">
            <span className="font-mono text-sky-700 dark:text-sky-300 tabular-nums shrink-0">
              {j.processed}/{j.total} ({pct}%)
            </span>
            <div className="flex-1 h-1.5 bg-sky-100 dark:bg-sky-900/40 rounded-full overflow-hidden">
              <div
                className="h-full bg-sky-500 transition-[width] duration-300"
                style={{ width: `${pct}%` }}
                aria-hidden
              />
            </div>
            {j.failed > 0 && (
              <span className="text-rose-600 dark:text-rose-400 tabular-nums shrink-0">
                {t('products.bulk.failedCount', { count: j.failed })}
              </span>
            )}
            <span className="text-slate-500 dark:text-slate-400 font-mono text-[10px] shrink-0">
              {j.jobId.slice(0, 8)}
            </span>
          </div>
        )
      })}
    </div>
  )
}
