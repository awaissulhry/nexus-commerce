/**
 * Phase 3 — hourly reconciliation of orphaned OPEN_ORDER reservations.
 * Releases holds for cancelled orders, consumes for shipped/delivered, and
 * alerts (logs) on ambiguous cases. Gated by NEXUS_RESERVATION_RECONCILE.
 */
import cron from 'node-cron'
import { reconcileOpenOrderReservations } from '../services/reservation-reconcile.js'
import { recordCronRun } from '../utils/cron-observability.js'
import { logger } from '../utils/logger.js'

const JOB = 'reservation-reconcile'
let scheduledTask: ReturnType<typeof cron.schedule> | null = null

export function startReservationReconcileCron(): void {
  if (process.env.NEXUS_RESERVATION_RECONCILE === '0') {
    logger.info('reservation-reconcile cron: disabled via env')
    return
  }
  if (scheduledTask) {
    logger.warn('reservation-reconcile cron already started — skipping')
    return
  }
  const schedule = process.env.NEXUS_RESERVATION_RECONCILE_SCHEDULE ?? '15 * * * *' // hourly at :15
  if (!cron.validate(schedule)) {
    logger.error('reservation-reconcile cron: invalid schedule, not starting', { schedule })
    return
  }
  scheduledTask = cron.schedule(schedule, () => {
    void recordCronRun(JOB, async () => {
      const r = await reconcileOpenOrderReservations()
      return `scanned=${r.scanned} released=${r.released} consumed=${r.consumed} alerted=${r.alerted} negAvail=${r.negativeAvailable}${r.capped ? ' (capped)' : ''}`
    }).catch((err) => {
      logger.error('reservation-reconcile cron: run failed', {
        err: err instanceof Error ? err.message : String(err),
      })
    })
  })
  logger.info('reservation-reconcile cron started', { schedule })
}
