/**
 * Amazon seller feedback (2026-10-27, Reviews PR H, build spec B20) — the daily fetch of Amazon's seller feedback report
 * (only feedback of 1 to 3 stars; Amazon cannot schedule this report itself, so Nexus asks once a day). Registered in
 * runtime/scheduler.ts next to the review crons, only when the deployment switches seller feedback on (the same switch
 * holds "Fetch now"). With business profiles on, `clustered.ts` runs it once per active business.
 */
import cron from '../lib/cron/clustered.js'
import { logger } from '../utils/logger.js'
import { runSellerFeedbackFetch, sellerFeedbackSchedule } from '../services/reviews/amazon-seller-feedback.service.js'

let task: ReturnType<typeof cron.schedule> | null = null

export async function runAmazonSellerFeedbackCron(): Promise<void> {
  try {
    const result = await runSellerFeedbackFetch({ trigger: 'cron' })
    logger.info('amazon-seller-feedback cron: completed', { summary: result.summary })
  } catch (err) {
    logger.error('amazon-seller-feedback cron: failure', { error: err instanceof Error ? err.message : String(err) })
  }
}

export function startAmazonSellerFeedbackCron(): void {
  if (task) { logger.warn('amazon-seller-feedback cron already started'); return }
  const schedule = sellerFeedbackSchedule()
  if (!cron.validate(schedule)) { logger.error('amazon-seller-feedback cron: invalid schedule', { schedule }); return }
  task = cron.schedule(schedule, async () => { await runAmazonSellerFeedbackCron() })
  logger.info('amazon-seller-feedback cron: scheduled', { schedule })
}

export function stopAmazonSellerFeedbackCron(): void {
  task?.stop()
  task = null
}
