/**
 * W1.3 — Orphan-PENDING bulk-job cleanup.
 *
 * The /bulk-operations audit (2026-05-09) found a stuck PENDING job
 * (deploy-probe, 3 days old, no startedAt). Root cause: someone POSTed
 * to /api/bulk-operations to create a job but never followed up with
 * /:id/process, so the row sat PENDING forever, taking a Cancel button
 * slot on the active-jobs strip and confusing operators.
 *
 * This sweep runs hourly and auto-cancels PENDING / QUEUED jobs that
 * have been sitting > ORPHAN_THRESHOLD_MS without a startedAt timestamp.
 * IN_PROGRESS jobs are left alone — they have a worker that's still
 * processing items (or the worker died, in which case CANCELLING via the
 * UI is the right path, not auto-sweep).
 *
 * Idempotent: an already-CANCELLED job is filtered out by the where
 * clause. Safe to run many times in a row.
 */

import prisma from '../db.js'
import { recordCronRun } from '../utils/cron-observability.js'

/**
 * One hour. Aligned with the cron interval below — a job created
 * during one tick and left alone is auto-cancelled at the next tick,
 * giving operators ~1h to actually press Process before the sweep.
 */
const ORPHAN_THRESHOLD_MS = 60 * 60 * 1000

export async function runOrphanBulkJobCleanupOnce(): Promise<{
  cancelled: number
  ids: string[]
}> {
  const now = new Date()
  const cutoff = new Date(now.getTime() - ORPHAN_THRESHOLD_MS)

  // Two failure modes covered:
  //   1. PENDING / QUEUED forever — the create-then-don't-process flow.
  //   2. IN_PROGRESS but startedAt is null — should never happen but
  //      processJob updates startedAt as the very first DB write, so
  //      a row in IN_PROGRESS without it is wedged. We do NOT touch
  //      these; the operator's Cancel button (W1.1) is the right tool.
  const candidates = await prisma.bulkActionJob.findMany({
    where: {
      status: { in: ['PENDING', 'QUEUED'] },
      startedAt: null,
      createdAt: { lt: cutoff },
    },
    select: { id: true, jobName: true, createdAt: true },
  })

  if (candidates.length === 0) {
    return { cancelled: 0, ids: [] }
  }

  await prisma.bulkActionJob.updateMany({
    where: { id: { in: candidates.map((c) => c.id) } },
    data: {
      status: 'CANCELLED',
      completedAt: now,
      lastError: 'Auto-cancelled by orphan-cleanup sweep — job never ' +
        'started processing within the orphan threshold.',
      updatedAt: now,
    },
  })

  return {
    cancelled: candidates.length,
    ids: candidates.map((c) => c.id),
  }
}

let cleanupTimer: NodeJS.Timeout | null = null

/**
 * Schedule the orphan sweep once per hour (best-effort in-process).
 * For multi-instance deploys this should move to a queued cron so
 * only one node runs the sweep, but at the current scale (9 jobs
 * total in production as of audit) the duplicate-run cost is zero —
 * `updateMany` on already-CANCELLED rows is a no-op.
 */
export function startOrphanBulkJobCleanupCron(): void {
  if (cleanupTimer) return
  const ONE_HOUR = ORPHAN_THRESHOLD_MS

  void recordCronRun('bulk-job-orphan-cleanup', async () => {
    const r = await runOrphanBulkJobCleanupOnce()
    return `cancelled=${r.cancelled}`
  }).catch((err) => {
    console.warn(
      '[bulk-job-orphan-cleanup] initial run failed:',
      err instanceof Error ? err.message : String(err),
    )
  })

  cleanupTimer = setInterval(() => {
    void recordCronRun('bulk-job-orphan-cleanup', async () => {
      const r = await runOrphanBulkJobCleanupOnce()
      return `cancelled=${r.cancelled}`
    }).catch((err) => {
      console.warn(
        '[bulk-job-orphan-cleanup] tick failed:',
        err instanceof Error ? err.message : String(err),
      )
    })
  }, ONE_HOUR)
}

export function stopOrphanBulkJobCleanupCron(): void {
  if (cleanupTimer) {
    clearInterval(cleanupTimer)
    cleanupTimer = null
  }
}
