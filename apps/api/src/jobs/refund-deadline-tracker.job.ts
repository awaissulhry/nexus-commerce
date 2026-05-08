/**
 * R6.2 — refund-deadline tracker cron.
 *
 * Default schedule: hourly, 10 past the hour. Each tick scans
 * Returns approaching or past their channel-specific refund
 * deadline and fires Notifications (severity=warn for
 * approaching, danger for overdue) to the configured ops user.
 *
 * Default-OFF. Operators flip
 *   NEXUS_ENABLE_REFUND_DEADLINE_TRACKER=1
 * once Italian compliance reporting starts mattering. Notifications
 * also need NEXUS_REFUND_DEADLINE_NOTIFY_USER_ID set so the rows
 * have a recipient — the scan still updates counters when that's
 * unset, only the side-effect is gated.
 *
 * The 10-past-the-hour offset stays clear of the on-the-hour
 * cluster (Amazon orders, FBA inventory, etc.) so an overloaded
 * tick doesn't compound.
 */

import cron from 'node-cron'
import { logger } from '../utils/logger.js'
import { scanAndNotifyRefundDeadlines } from '../services/return-policies/deadline-tracker.service.js'

let scheduledTask: ReturnType<typeof cron.schedule> | null = null

async function runScan(): Promise<void> {
  const startedAt = Date.now()
  try {
    const result = await scanAndNotifyRefundDeadlines()
    logger.info('refund-deadline-tracker cron: tick complete', {
      durationMs: Date.now() - startedAt,
      ...result,
    })
  } catch (err) {
    logger.error('refund-deadline-tracker cron: failure', {
      durationMs: Date.now() - startedAt,
      error: err instanceof Error ? err.message : String(err),
    })
  }
}

export function startRefundDeadlineTrackerCron(): void {
  if (scheduledTask) {
    logger.warn('refund-deadline-tracker cron already started — skipping')
    return
  }
  if (process.env.NEXUS_ENABLE_REFUND_DEADLINE_TRACKER !== '1') {
    logger.info('refund-deadline-tracker cron: disabled (set NEXUS_ENABLE_REFUND_DEADLINE_TRACKER=1 to enable)')
    return
  }
  const schedule = process.env.NEXUS_REFUND_DEADLINE_TRACKER_SCHEDULE ?? '10 * * * *'
  if (!cron.validate(schedule)) {
    logger.error('refund-deadline-tracker cron: invalid schedule', { schedule })
    return
  }
  scheduledTask = cron.schedule(schedule, () => {
    void runScan()
  })
  logger.info('refund-deadline-tracker cron: scheduled', { schedule })
}

export function stopRefundDeadlineTrackerCron(): void {
  if (scheduledTask) {
    scheduledTask.stop()
    scheduledTask = null
  }
}

export { runScan as runRefundDeadlineScan }
