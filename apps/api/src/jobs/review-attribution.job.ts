/**
 * RV.9.7 — Review attribution cron. Runs every 6h to bind newly
 * ingested Reviews back to the SENT ReviewRequest (and its rule) that
 * heuristically caused them.
 *
 * Gated by the same NEXUS_ENABLE_REVIEW_INGEST=1 flag as the rest of
 * the review pipeline. Idempotent — only touches rows where
 * attributedRequestId IS NULL.
 */

import cron from 'node-cron'
import { runReviewAttributionOnce } from '../services/reviews/review-attribution.service.js'
import { recordCronRun } from '../utils/cron-observability.js'
import { logger } from '../utils/logger.js'

let scheduledTask: ReturnType<typeof cron.schedule> | null = null

export function startReviewAttributionCron(): void {
  if (scheduledTask) {
    logger.warn('review-attribution: already started — skipping')
    return
  }
  const schedule = process.env.NEXUS_REVIEW_ATTRIBUTION_SCHEDULE ?? '0 */6 * * *'
  if (!cron.validate(schedule)) {
    logger.error('review-attribution: invalid schedule', { schedule })
    return
  }
  scheduledTask = cron.schedule(schedule, () => {
    void (async () => {
      try {
        await recordCronRun('review-attribution', async () => {
          const r = await runReviewAttributionOnce()
          return `scanned=${r.scanned} attributed=${r.attributed} durationMs=${r.durationMs}`
        })
      } catch (err) {
        logger.warn('[review-attribution] tick failed', {
          error: err instanceof Error ? err.message : String(err),
        })
      }
    })()
  })
  logger.info('review-attribution: scheduled', { schedule })
}

export function stopReviewAttributionCron(): void {
  if (scheduledTask) {
    scheduledTask.stop()
    scheduledTask = null
  }
}
