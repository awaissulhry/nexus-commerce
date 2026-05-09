/**
 * W6.2 — Scheduled bulk-action tick.
 *
 * Runs every minute. Pulls due schedules off
 * ScheduledBulkActionService.findDueSchedules and fires each via
 * BulkActionService.createJob (then immediately processJob, since
 * the existing pattern is "createJob → processJob → poll status").
 *
 * Best-effort per-row: any one schedule throwing logs + bumps the
 * row's lastError but never aborts the tick — operators chaining a
 * dozen schedules don't want a single bad cron entry blocking the
 * rest.
 *
 * Boot integration via startScheduledBulkActionCron() in index.ts.
 * Skips silently when no rows are due — the index seek on
 * (enabled, nextRunAt) keeps the no-op tick under a millisecond.
 */

import prisma from '../db.js'
import { recordCronRun } from '../utils/cron-observability.js'
import { logger } from '../utils/logger.js'
import {
  ScheduledBulkActionService,
} from '../services/scheduled-bulk-action.service.js'
import {
  BulkActionService,
  type BulkActionType,
} from '../services/bulk-action.service.js'

const TICK_INTERVAL_MS = 60_000

let tickTimer: NodeJS.Timeout | null = null

const scheduleService = new ScheduledBulkActionService(prisma)
const bulkActionService = new BulkActionService(prisma)

interface TickSummary {
  considered: number
  fired: number
  failed: number
  skipped: number
}

export async function runScheduledBulkActionTickOnce(): Promise<TickSummary> {
  const now = new Date()
  const due = await scheduleService.findDueSchedules(now, 50)
  if (due.length === 0) {
    return { considered: 0, fired: 0, failed: 0, skipped: 0 }
  }
  let fired = 0
  let failed = 0
  let skipped = 0
  for (const row of due) {
    // Re-check enabled flag on each row in case the operator
    // disabled it between findDueSchedules and now.
    if (!row.enabled) {
      await scheduleService.markFired(row.id, {
        jobId: null,
        status: 'SKIPPED',
        error: 'disabled before tick fired',
      })
      skipped++
      continue
    }
    try {
      const filters = (row.filters ?? undefined) as
        | Record<string, unknown>
        | undefined
      const job = await bulkActionService.createJob({
        jobName: `[scheduled] ${row.name}`,
        actionType: row.actionType as BulkActionType,
        channel: row.channel ?? undefined,
        actionPayload: (row.actionPayload ?? {}) as Record<string, unknown>,
        targetProductIds:
          row.targetProductIds.length > 0 ? row.targetProductIds : undefined,
        targetVariationIds:
          row.targetVariationIds.length > 0
            ? row.targetVariationIds
            : undefined,
        filters,
        createdBy: row.createdBy ?? 'scheduled',
      } as never)
      // Fire-and-forget the actual processing — schedule consumers
      // aren't awaiting the result; status flows through the active-
      // jobs strip + the schedule's lastJobId pointer.
      void bulkActionService.processJob(job.id).catch((err) => {
        logger.warn(
          `[scheduled-bulk-action] processJob ${job.id} from schedule ${row.id} failed: ${err instanceof Error ? err.message : String(err)}`,
        )
      })
      await scheduleService.markFired(row.id, {
        jobId: job.id,
        status: 'SUCCESS',
      })
      // W7.2 — fire the schedule_fired automation trigger.
      // Lazy-imported to break a cycle with the trigger module's
      // own use of the schedule service via prisma. Best-effort.
      try {
        const { emitScheduleFired } = await import(
          '../services/automation/bulk-ops-triggers.js'
        )
        emitScheduleFired({
          scheduleId: row.id,
          name: row.name,
          actionType: row.actionType,
          runCount: row.runCount + 1,
          cronExpression: row.cronExpression,
          jobId: job.id,
        })
      } catch (emitErr) {
        logger.warn(
          `[scheduled-bulk-action] emit schedule_fired failed: ${emitErr instanceof Error ? emitErr.message : String(emitErr)}`,
        )
      }
      fired++
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      logger.error(
        `[scheduled-bulk-action] schedule ${row.id} fire failed: ${message}`,
      )
      await scheduleService.markFired(row.id, {
        jobId: null,
        status: 'FAILED',
        error: message,
      })
      failed++
    }
  }
  return { considered: due.length, fired, failed, skipped }
}

export async function runScheduledBulkActionCronOnce(): Promise<void> {
  await recordCronRun('scheduled-bulk-action', async () => {
    const r = await runScheduledBulkActionTickOnce()
    return `considered=${r.considered} fired=${r.fired} failed=${r.failed} skipped=${r.skipped}`
  }).catch((err) => {
    logger.warn(
      `[scheduled-bulk-action] tick failed: ${err instanceof Error ? err.message : String(err)}`,
    )
  })
}

export function startScheduledBulkActionCron(): void {
  if (tickTimer) return
  // Fire once at boot so a redeploy with backed-up schedules
  // catches up immediately rather than waiting a minute.
  void runScheduledBulkActionCronOnce()
  tickTimer = setInterval(() => {
    void runScheduledBulkActionCronOnce()
  }, TICK_INTERVAL_MS)
}

export function stopScheduledBulkActionCron(): void {
  if (tickTimer) {
    clearInterval(tickTimer)
    tickTimer = null
  }
}
