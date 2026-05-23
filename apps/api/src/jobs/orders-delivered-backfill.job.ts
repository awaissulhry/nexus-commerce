/**
 * RV.7.2 — Cron wrapper for orders-delivered-backfill.
 *
 * Schedule: 03:30 UTC daily by default (after the main Amazon orders
 * sync at ~03:00 so the report's order rows match what's in our DB).
 *
 * Gated behind NEXUS_ENABLE_REVIEW_INGEST=1 (same gate as the mailer
 * cron — both serve the review pipeline).
 *
 * Override schedule via NEXUS_ORDERS_DELIVERED_BACKFILL_SCHEDULE.
 */

import cron from 'node-cron'
import { logger } from '../utils/logger.js'
import { recordCronRun } from '../utils/cron-observability.js'
import { runOrdersDeliveredBackfill } from '../services/reviews/orders-delivered-backfill.service.js'

let scheduledTask: ReturnType<typeof cron.schedule> | null = null

export async function runOrdersDeliveredBackfillCron(): Promise<void> {
  try {
    await recordCronRun('orders-delivered-backfill', async () => {
      const result = await runOrdersDeliveredBackfill({})
      logger.info('orders-delivered-backfill cron: completed', { result })
      return [
        `marketplaces=${result.marketplaces}`,
        `reports=${result.reports}`,
        `rowsParsed=${result.rowsParsed}`,
        `updated=${result.ordersUpdated}`,
        `alreadyAuth=${result.ordersAlreadyAuthoritative}`,
        `notFound=${result.ordersNotFound}`,
        `errors=${result.errors}`,
        `durationMs=${result.durationMs}`,
      ].join(' ')
    })
  } catch (err) {
    logger.error('orders-delivered-backfill cron: failure', {
      error: err instanceof Error ? err.message : String(err),
    })
  }
}

export function startOrdersDeliveredBackfillCron(): void {
  if (scheduledTask) {
    logger.warn('orders-delivered-backfill cron already started — skipping')
    return
  }
  const schedule =
    process.env.NEXUS_ORDERS_DELIVERED_BACKFILL_SCHEDULE ?? '30 3 * * *'
  if (!cron.validate(schedule)) {
    logger.error('orders-delivered-backfill cron: invalid schedule expression', {
      schedule,
    })
    return
  }
  scheduledTask = cron.schedule(schedule, () => {
    void runOrdersDeliveredBackfillCron()
  })
  logger.info('orders-delivered-backfill cron: started', { schedule })
}

export function stopOrdersDeliveredBackfillCron(): void {
  if (scheduledTask) {
    scheduledTask.stop()
    scheduledTask = null
  }
}
