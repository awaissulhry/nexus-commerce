/**
 * H.8 — Reservation TTL sweep cron.
 *
 * Walks StockReservation looking for PENDING_ORDER rows past their
 * expiresAt and releases them via stock-level.service.releaseReservation.
 * The release decrements StockLevel.reserved (and updates available)
 * + writes a RESERVATION_RELEASED audit row.
 *
 * Cadence: 5 min by default. Tighter than that wastes DB cycles since
 * reservations are 24h TTL. Looser leaves stock under-promised for
 * up to N minutes after a cancelled order, which can cause oversells
 * if a customer immediately retries.
 *
 * Gated behind NEXUS_ENABLE_RESERVATION_SWEEP_CRON. Default-ON because
 * a forgotten env flag silently leaving stock locked is exactly the
 * failure mode this cron exists to prevent. Set to '0' to opt out.
 */

import cron from 'node-cron'
import { sweepExpiredReservations } from '../services/stock-level.service.js'
import { logger } from '../utils/logger.js'
import { recordCronRun } from '../utils/cron-observability.js'

let scheduledTask: ReturnType<typeof cron.schedule> | null = null
let lastRunAt: Date | null = null
let lastReleasedCount = 0

async function runSweep(): Promise<void> {
  try {
    await recordCronRun('reservation-sweep', async () => {
      const released = await sweepExpiredReservations()
      lastRunAt = new Date()
      lastReleasedCount = released
      if (released > 0) {
        logger.info('reservation-sweep: released expired reservations', { released })
      }
      return `released=${released}`
    })
  } catch (err) {
    logger.error('reservation-sweep: failed', {
      error: err instanceof Error ? err.message : String(err),
    })
  }
}

export function startReservationSweepCron(): void {
  if (scheduledTask) {
    logger.warn('reservation-sweep cron already started — skipping')
    return
  }

  const schedule = process.env.NEXUS_RESERVATION_SWEEP_SCHEDULE ?? '*/5 * * * *'

  if (!cron.validate(schedule)) {
    logger.error('reservation-sweep cron: invalid schedule expression', { schedule })
    return
  }

  scheduledTask = cron.schedule(schedule, () => {
    void runSweep()
  })

  logger.info('reservation-sweep cron: scheduled', { schedule })
}

export function stopReservationSweepCron(): void {
  if (scheduledTask) {
    scheduledTask.stop()
    scheduledTask = null
  }
}

export function getReservationSweepStatus(): {
  scheduled: boolean
  lastRunAt: Date | null
  lastReleasedCount: number
} {
  return {
    scheduled: scheduledTask !== null,
    lastRunAt,
    lastReleasedCount,
  }
}

export { runSweep as runReservationSweep }
