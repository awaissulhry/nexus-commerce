/**
 * MB.1 — Brand Brain embedding ingester cron.
 *
 * Runs every 6h under NEXUS_ENABLE_BRAND_BRAIN=1. Re-embeds all
 * BrandKit + BrandVoice + APlusContent (published) rows. Upserts are
 * idempotent — if the text hasn't changed, the same vector is written
 * (same cost as the initial embed with a real API; no-op with the mock).
 *
 * A future optimisation: diff by updatedAt + last-indexed timestamp and
 * skip unchanged rows. At Xavia scale (< 300 SKUs, few brand kits) the
 * full sweep is ≤ €0.001 per tick.
 */

import cron from 'node-cron'
import { logger } from '../utils/logger.js'
import { recordCronRun } from '../utils/cron-observability.js'
import { ingestAllPendingContent } from '../services/ai/brand-brain.service.js'

let scheduledTask: ReturnType<typeof cron.schedule> | null = null
let lastRunAt: Date | null = null
let lastSummary: string | null = null

export async function runEmbeddingIngesterOnce(): Promise<string> {
  const summary = await ingestAllPendingContent()
  lastRunAt = new Date()
  lastSummary = `brandKits=${summary.brandKits} brandVoices=${summary.brandVoices} aplus=${summary.aplusContents} errors=${summary.errors}`
  return lastSummary
}

export async function runEmbeddingIngesterCron(): Promise<void> {
  try {
    await recordCronRun('embedding-ingester', async () => {
      const summary = await runEmbeddingIngesterOnce()
      logger.info('embedding-ingester cron: completed', { summary })
      return summary
    })
  } catch (err) {
    logger.error('embedding-ingester cron: failure', {
      error: err instanceof Error ? err.message : String(err),
    })
  }
}

export function startEmbeddingIngesterCron(): void {
  if (scheduledTask) {
    logger.warn('embedding-ingester cron already started')
    return
  }
  const schedule = process.env.NEXUS_EMBEDDING_INGESTER_SCHEDULE ?? '0 */6 * * *'
  if (!cron.validate(schedule)) {
    logger.error('embedding-ingester cron: invalid schedule', { schedule })
    return
  }
  scheduledTask = cron.schedule(schedule, () => {
    void runEmbeddingIngesterCron()
  })
  logger.info('embedding-ingester cron: scheduled', { schedule })
}

export function stopEmbeddingIngesterCron(): void {
  if (scheduledTask) {
    scheduledTask.stop()
    scheduledTask = null
  }
}

export function getEmbeddingIngesterStatus(): {
  scheduled: boolean
  lastRunAt: Date | null
  lastSummary: string | null
} {
  return { scheduled: scheduledTask != null, lastRunAt, lastSummary }
}
