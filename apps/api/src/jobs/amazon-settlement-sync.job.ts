/**
 * Daily Amazon settlement reports sync cron.
 *
 * Schedule: 03:30 UTC daily. Amazon publishes settlement reports on a
 * ~weekly cadence, so daily is more than enough to catch every new
 * report. Window: last 14 days (covers two settlement cycles for safety).
 *
 * Idempotent — `syncSettlementReports` skips reports whose reportId is
 * already in `SettlementReport`. Re-running over the same window is a
 * no-op once data is current.
 *
 * Gated behind NEXUS_ENABLE_AMAZON_SETTLEMENT_CRON=1.
 */

import cron from 'node-cron'
import { logger } from '../utils/logger.js'
import { syncSettlementReports } from '../services/amazon-settlements.service.js'
import { recordCronRun } from '../utils/cron-observability.js'

let scheduledTask: ReturnType<typeof cron.schedule> | null = null

async function runSettlementSync(): Promise<void> {
  const startedAt = Date.now()
  await recordCronRun('amazon-settlement-sync', async () => {
    const to = new Date()
    const from = new Date(to.getTime() - 14 * 24 * 60 * 60 * 1000)
    const result = await syncSettlementReports({ from, to })
    logger.info('amazon-settlement cron: tick complete', {
      durationMs: Date.now() - startedAt,
      reportsListed: result.totals.reportsListed,
      reportsUpserted: result.totals.reportsUpserted,
      errors: result.totals.errors,
    })
    return `listed=${result.totals.reportsListed} upserted=${result.totals.reportsUpserted} errors=${result.totals.errors}`
  }).catch((err) => {
    logger.error('amazon-settlement cron: failure', {
      durationMs: Date.now() - startedAt,
      error: err instanceof Error ? err.message : String(err),
    })
  })
}

export function startAmazonSettlementCron(): void {
  if (scheduledTask) {
    logger.warn('amazon-settlement cron already started — skipping')
    return
  }
  if (process.env.NEXUS_ENABLE_AMAZON_SETTLEMENT_CRON !== '1') {
    logger.info('amazon-settlement cron: disabled (set NEXUS_ENABLE_AMAZON_SETTLEMENT_CRON=1 to enable)')
    return
  }
  // Daily at 03:30 UTC. Off-by-30-minutes from financial-sync (02:00)
  // and orders-sync clusters to spread API load.
  const schedule = process.env.NEXUS_AMAZON_SETTLEMENT_CRON_SCHEDULE ?? '30 3 * * *'
  if (!cron.validate(schedule)) {
    logger.error('amazon-settlement cron: invalid schedule expression', { schedule })
    return
  }
  scheduledTask = cron.schedule(schedule, () => {
    void runSettlementSync()
  })
  logger.info('amazon-settlement cron: scheduled', { schedule })
}

export function stopAmazonSettlementCron(): void {
  if (scheduledTask) {
    scheduledTask.stop()
    scheduledTask = null
  }
}

export { runSettlementSync }
