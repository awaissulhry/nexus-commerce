/**
 * W8.4 — Scheduled-import tick.
 *
 * Mirrors the W6.2 scheduled-bulk-action worker but for imports.
 * Runs every 5 min — imports are cheaper than schedules in volume
 * but each fetch is a network call so a more relaxed cadence is
 * fine.
 */

import prisma from '../db.js'
import { recordCronRun } from '../utils/cron-observability.js'
import { logger } from '../utils/logger.js'
import { ScheduledImportService } from '../services/scheduled-import.service.js'

const TICK_INTERVAL_MS = 5 * 60 * 1000

let tickTimer: NodeJS.Timeout | null = null

const scheduleService = new ScheduledImportService(prisma)

interface TickSummary {
  considered: number
  fired: number
  failed: number
  skipped: number
}

export async function runScheduledImportTickOnce(): Promise<TickSummary> {
  const now = new Date()
  const due = await scheduleService.findDue(now, 10)
  if (due.length === 0) {
    return { considered: 0, fired: 0, failed: 0, skipped: 0 }
  }
  let fired = 0
  let failed = 0
  let skipped = 0
  for (const row of due) {
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
      const result = await scheduleService.fireOnce(row)
      await scheduleService.markFired(row.id, {
        jobId: result.jobId,
        status: result.status,
      })
      fired++
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      logger.error(
        `[scheduled-import] schedule ${row.id} fire failed: ${message}`,
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

export async function runScheduledImportCronOnce(): Promise<void> {
  await recordCronRun('scheduled-import', async () => {
    const r = await runScheduledImportTickOnce()
    return `considered=${r.considered} fired=${r.fired} failed=${r.failed} skipped=${r.skipped}`
  }).catch((err) => {
    logger.warn(
      `[scheduled-import] tick failed: ${err instanceof Error ? err.message : String(err)}`,
    )
  })
}

export function startScheduledImportCron(): void {
  if (tickTimer) return
  // Don't fire at boot — a backed-up queue triggering N HTTP fetches
  // simultaneously on restart is unfriendly to upstream sources.
  // Wait one interval.
  tickTimer = setInterval(() => {
    void runScheduledImportCronOnce()
  }, TICK_INTERVAL_MS)
}

export function stopScheduledImportCron(): void {
  if (tickTimer) {
    clearInterval(tickTimer)
    tickTimer = null
  }
}
