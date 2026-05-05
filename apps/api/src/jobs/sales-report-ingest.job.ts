/**
 * F.3.3 — Nightly Amazon Sales & Traffic ingest cron.
 *
 * Runs every day at the configured hour (default 02:00 UTC) and ingests
 * yesterday's Sales & Traffic report for every active Amazon marketplace.
 *
 * Pattern mirrors wizard-cleanup.job.ts — node-cron with a startup tick
 * so testers can verify the wiring without waiting until 2 AM.
 *
 * Gated behind NEXUS_ENABLE_SALES_REPORT_CRON=1. Without that env var,
 * the cron is dormant and the manual trigger endpoint at
 * POST /api/fulfillment/sales-reports/ingest is the only entry point.
 *
 * Failure handling: each marketplace runs independently via
 * ingestAllAmazonMarketplaces; failures are logged but don't stop the
 * cron. The next nightly run will catch up.
 */

import cron from 'node-cron'
import { ingestAllAmazonMarketplaces } from '../services/sales-report-ingest.service.js'
import { logger } from '../utils/logger.js'

let scheduledTask: ReturnType<typeof cron.schedule> | null = null

/**
 * Run the ingest for "yesterday" (Amazon's reports are typically
 * available T+1; running at 02:00 UTC for yesterday's data is the
 * conservative pattern most sellers use).
 */
async function runYesterdayIngest(): Promise<void> {
  const yesterday = new Date()
  yesterday.setUTCHours(0, 0, 0, 0)
  yesterday.setUTCDate(yesterday.getUTCDate() - 1)

  logger.info('sales-report-ingest cron: tick', {
    day: yesterday.toISOString().slice(0, 10),
  })

  try {
    const results = await ingestAllAmazonMarketplaces(yesterday)
    const succeeded = results.filter((r) => 'rowsUpserted' in r).length
    const failed = results.filter((r) => 'error' in r).length
    logger.info('sales-report-ingest cron: complete', {
      day: yesterday.toISOString().slice(0, 10),
      marketplacesProcessed: results.length,
      succeeded,
      failed,
    })
  } catch (err) {
    logger.error('sales-report-ingest cron: top-level failure', {
      error: err instanceof Error ? err.message : String(err),
    })
  }
}

export function startSalesReportIngestCron(): void {
  if (scheduledTask) {
    logger.warn('sales-report-ingest cron already started — skipping')
    return
  }

  // Default 02:00 UTC daily. Override via NEXUS_SALES_REPORT_CRON_SCHEDULE
  // (any valid 5-field cron expression). 02:00 is conservative — Amazon's
  // reports for yesterday are usually fully populated by midnight UTC, so
  // 02:00 gives a 2-hour buffer.
  const schedule = process.env.NEXUS_SALES_REPORT_CRON_SCHEDULE ?? '0 2 * * *'

  if (!cron.validate(schedule)) {
    logger.error('sales-report-ingest cron: invalid schedule expression', {
      schedule,
    })
    return
  }

  scheduledTask = cron.schedule(schedule, () => {
    void runYesterdayIngest()
  })

  logger.info('sales-report-ingest cron: scheduled', { schedule })
}

export function stopSalesReportIngestCron(): void {
  if (scheduledTask) {
    scheduledTask.stop()
    scheduledTask = null
  }
}

/**
 * Exposed for manual / tests. Triggers the same path the cron does.
 */
export { runYesterdayIngest }
