/**
 * W9.4 — Scheduled-export tick.
 *
 * Mirrors the W8.4 scheduled-import worker shape. 5-minute cadence
 * — exports are cheap to render, expensive to deliver, and the
 * delivery transport (notification log / webhook POST) is fine on
 * a 5-min tick.
 */

import prisma from '../db.js'
import { recordCronRun } from '../utils/cron-observability.js'
import { logger } from '../utils/logger.js'
import { ScheduledExportService } from '../services/scheduled-export.service.js'

const TICK_INTERVAL_MS = 5 * 60 * 1000

let tickTimer: NodeJS.Timeout | null = null

const scheduleService = new ScheduledExportService(prisma)

interface TickSummary {
  considered: number
  fired: number
  failed: number
  skipped: number
}

export async function runScheduledExportTickOnce(): Promise<TickSummary> {
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
        bytes: result.bytes,
        rowCount: result.rowCount,
      })
      fired++
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      logger.error(
        `[scheduled-export] schedule ${row.id} fire failed: ${message}`,
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

export async function runScheduledExportCronOnce(): Promise<void> {
  await recordCronRun('scheduled-export', async () => {
    const r = await runScheduledExportTickOnce()
    return `considered=${r.considered} fired=${r.fired} failed=${r.failed} skipped=${r.skipped}`
  }).catch((err) => {
    logger.warn(
      `[scheduled-export] tick failed: ${err instanceof Error ? err.message : String(err)}`,
    )
  })
}

export function startScheduledExportCron(): void {
  if (tickTimer) return
  // Don't fire at boot — backed-up queue triggering N exports
  // simultaneously on restart is unfriendly to the catalog query
  // path. Wait one interval.
  tickTimer = setInterval(() => {
    void runScheduledExportCronOnce()
  }, TICK_INTERVAL_MS)
}

export function stopScheduledExportCron(): void {
  if (tickTimer) {
    clearInterval(tickTimer)
    tickTimer = null
  }
}
