/**
 * Amazon Financial Events daily sync cron.
 *
 * Runs once per day at 03:00 Italy time (02:00 UTC) — after Amazon
 * settlement windows typically close for the prior day.
 *
 * Pulls yesterday's financial events and writes FinancialTransaction rows.
 * Idempotent: skips events already recorded for a given order.
 *
 * Gated behind NEXUS_ENABLE_AMAZON_FINANCIAL_CRON=1.
 */

import cron from 'node-cron'
import { syncYesterdayFinancialEvents } from '../services/amazon-financial-events.service.js'
import { logger } from '../utils/logger.js'
import { recordCronRun } from '../utils/cron-observability.js'

let scheduledTask: ReturnType<typeof cron.schedule> | null = null

async function runFinancialSync(): Promise<void> {
  try {
    await recordCronRun('amazon-financial-sync', async () => {
      const summary = await syncYesterdayFinancialEvents()
      return `orderEvents=${summary.orderEventsFetched} refundEvents=${summary.refundEventsFetched} created=${summary.txCreated} skipped=${summary.txSkipped} matched=${summary.ordersMatched} ms=${summary.durationMs}`
    })
  } catch (err) {
    logger.error('amazon-financial-sync cron: top-level failure', {
      error: err instanceof Error ? err.message : String(err),
    })
  }
}

export function startAmazonFinancialSyncCron(): void {
  if (scheduledTask) return

  const schedule = process.env.NEXUS_AMAZON_FINANCIAL_CRON_SCHEDULE ?? '0 2 * * *' // 02:00 UTC daily

  if (!cron.validate(schedule)) {
    logger.error('amazon-financial-sync cron: invalid schedule', { schedule })
    return
  }

  scheduledTask = cron.schedule(schedule, () => { void runFinancialSync() })
  logger.info('amazon-financial-sync cron: scheduled', { schedule })
}

export function stopAmazonFinancialSyncCron(): void {
  if (scheduledTask) { scheduledTask.stop(); scheduledTask = null }
}

export { runFinancialSync }
