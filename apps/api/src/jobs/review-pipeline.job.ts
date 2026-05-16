/**
 * SR.1 — Cron wrappers for the review pipeline.
 *
 *   review-ingest          every 30 min — pulls reviews + sentiment
 *   review-spike-detector  every 60 min — scans for category spikes
 *
 * Both gated by NEXUS_ENABLE_REVIEW_INGEST=1. Default off so a fresh
 * install doesn't immediately spawn LLM calls.
 */

import cron from 'node-cron'
import { logger } from '../utils/logger.js'
import { recordCronRun } from '../utils/cron-observability.js'
import {
  runReviewIngestOnce,
  summarizeReviewIngest,
} from '../services/reviews/review-ingest.service.js'
import {
  runSpikeDetectorOnce,
  summarizeSpikeDetector,
} from '../services/reviews/spike-detector.service.js'

let ingestTask: ReturnType<typeof cron.schedule> | null = null
let spikeTask: ReturnType<typeof cron.schedule> | null = null

export async function runReviewIngestCron(): Promise<void> {
  try {
    await recordCronRun('review-ingest', async () => {
      const s = await runReviewIngestOnce()
      const summary = summarizeReviewIngest(s)
      logger.info('review-ingest cron: completed', { summary })
      return summary
    })
  } catch (err) {
    logger.error('review-ingest cron: failure', {
      error: err instanceof Error ? err.message : String(err),
    })
  }
}

export async function runReviewSpikeDetectorCron(): Promise<void> {
  try {
    await recordCronRun('review-spike-detector', async () => {
      const s = await runSpikeDetectorOnce()
      const summary = summarizeSpikeDetector(s)
      logger.info('review-spike-detector cron: completed', { summary })
      return summary
    })
  } catch (err) {
    logger.error('review-spike-detector cron: failure', {
      error: err instanceof Error ? err.message : String(err),
    })
  }
}

export function startReviewIngestCron(): void {
  if (ingestTask) {
    logger.warn('review-ingest cron already started')
    return
  }
  const schedule = process.env.NEXUS_REVIEW_INGEST_SCHEDULE ?? '*/30 * * * *'
  if (!cron.validate(schedule)) {
    logger.error('review-ingest cron: invalid schedule', { schedule })
    return
  }
  ingestTask = cron.schedule(schedule, () => {
    void runReviewIngestCron()
  })
  logger.info('review-ingest cron: scheduled', { schedule })
}

export function startReviewSpikeDetectorCron(): void {
  if (spikeTask) {
    logger.warn('review-spike-detector cron already started')
    return
  }
  // Hourly at minute 17 — staggered off review-ingest's :00/:30 ticks
  // so ingest has time to populate ReviewCategoryRate first.
  const schedule = process.env.NEXUS_REVIEW_SPIKE_SCHEDULE ?? '17 * * * *'
  if (!cron.validate(schedule)) {
    logger.error('review-spike-detector cron: invalid schedule', { schedule })
    return
  }
  spikeTask = cron.schedule(schedule, () => {
    void runReviewSpikeDetectorCron()
  })
  logger.info('review-spike-detector cron: scheduled', { schedule })
}

export function startAllReviewCrons(): void {
  startReviewIngestCron()
  startReviewSpikeDetectorCron()
}

export function stopAllReviewCrons(): void {
  if (ingestTask) {
    ingestTask.stop()
    ingestTask = null
  }
  if (spikeTask) {
    spikeTask.stop()
    spikeTask = null
  }
}
