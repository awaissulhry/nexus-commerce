/**
 * RPT.6 — hourly cron dispatching due report schedules.
 *
 * Mirrors dashboard-digest.job: one tick an hour, each schedule fires when the
 * Europe/Rome civil hour matches and the previous send falls in a different
 * calendar period.
 *
 * Two independent gates, on purpose:
 *   - NEXUS_ENABLE_ADS_REPORT_SCHEDULE_CRON  — whether the cron runs at all
 *   - NEXUS_ENABLE_OUTBOUND_EMAILS           — whether anything actually leaves
 *
 * With the second unset every run is a full dry run: the report is built, the
 * file produced, the delivery logged, and nothing is mailed. That is what makes
 * "is my schedule right?" answerable without mailing anyone.
 */
import cron from 'node-cron'
import { logger } from '../utils/logger.js'
import { recordCronRun } from '../utils/cron-observability.js'
import { runDueSchedules } from '../services/advertising/ads-report-schedules.service.js'

let task: ReturnType<typeof cron.schedule> | null = null

export async function runAdsReportSchedulesOnce(): Promise<{ due: number; sent: number; failed: number }> {
  let summary = { due: 0, sent: 0, failed: 0 }
  // recordCronRun stores a STRING summary on the CronRun row, so the numbers are
  // captured out-of-band and a readable line is handed back for the run log.
  await recordCronRun('ads-report-schedule', async () => {
    summary = await runDueSchedules()
    if (summary.due > 0) logger.info('[ads-report-schedule] dispatched', summary)
    return `due=${summary.due} sent=${summary.sent} failed=${summary.failed}`
  })
  return summary
}

export function startAdsReportScheduleCron(): void {
  if (process.env.NEXUS_ENABLE_ADS_REPORT_SCHEDULE_CRON !== '1') {
    logger.info('[ads-report-schedule] cron disabled (NEXUS_ENABLE_ADS_REPORT_SCHEDULE_CRON != 1)')
    return
  }
  if (task) return
  // Five past the hour: the ads ingest crons run on the hour, so this gives the
  // day's data a moment to land before a report is built from it.
  task = cron.schedule('5 * * * *', () => {
    void runAdsReportSchedulesOnce().catch((err) => {
      logger.error('[ads-report-schedule] tick failed', { err: (err as Error).message })
    })
  })
  logger.info('[ads-report-schedule] cron started (hourly at :05)')
}
