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

/**
 * ACR.4.2 — the weekly autonomy digest, on the same hourly tick.
 *
 * Deliberately NOT a third env flag. This flag already means "the ads scheduled-email
 * dispatcher runs", and the digest is exactly that; adding another gate would make un-gating
 * the rail a two-step operation for no extra safety, since NEXUS_ENABLE_OUTBOUND_EMAILS still
 * independently decides whether anything leaves.
 *
 * Its own CronRun row, though, rather than folding into the report-schedule summary. A job that
 * reports SUCCESS while a component inside it fails is the exact shape that hid seven nights of
 * ToS-IS failures behind a green tick (ACR.0.2), and the digest is now the surface an operator
 * is being asked to trust INSTEAD of looking.
 */
async function runWeeklyDigestTick(): Promise<void> {
  const { dispatchWeeklyDigestIfDue, DIGEST_JOB_NAME } = await import('../services/advertising/ads-weekly-digest-mail.service.js')
  let outcome: string | null = null
  // Peek first: recordCronRun writes a row every time it is called, and a row per hour for a
  // job that only acts on Mondays would bury the ones that mean something.
  const probe = await dispatchWeeklyDigestIfDue().catch((err) => {
    logger.error('[ads-weekly-digest] tick failed', { err: (err as Error).message })
    return null
  })
  if (!probe) return
  outcome = `status=${probe.status} window=${probe.window} recipients=${probe.recipients.length}${probe.reason ? ` reason=${probe.reason.slice(0, 120)}` : ''}`
  await recordCronRun(DIGEST_JOB_NAME, async () => {
    // The send already happened above; this records it. A FAILED send must fail the CronRun,
    // or "the digest goes out on Mondays" becomes an assumption nobody can check.
    if (probe.status === 'FAILED') throw new Error(probe.reason ?? 'digest send failed')
    return outcome!
  }).catch(() => { /* the run log must never break the job it describes */ })
}

export function startAdsReportScheduleCron(): void {
  if (process.env.NEXUS_ENABLE_ADS_REPORT_SCHEDULE_CRON !== '1') {
    logger.info('[ads-report-schedule] cron disabled (NEXUS_ENABLE_ADS_REPORT_SCHEDULE_CRON != 1) — no saved-report schedules and no weekly digest will dispatch')
    return
  }
  if (task) return
  // Five past the hour: the ads ingest crons run on the hour, so this gives the
  // day's data a moment to land before a report is built from it.
  task = cron.schedule('5 * * * *', () => {
    void runAdsReportSchedulesOnce().catch((err) => {
      logger.error('[ads-report-schedule] tick failed', { err: (err as Error).message })
    })
    void runWeeklyDigestTick()
  })
  logger.info('[ads-report-schedule] cron started (hourly at :05, incl. weekly digest)')
}
