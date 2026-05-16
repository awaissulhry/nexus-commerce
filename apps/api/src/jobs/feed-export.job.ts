/**
 * CE.5 — Cross-RMN Feed Export cron.
 *
 * Runs daily at 06:00 UTC. Generates GMC XML + Meta JSON feeds and
 * stores metadata about the last generation. The actual feed bytes are
 * returned on-demand via the /api/feed-export/* endpoints; this job
 * exists to pre-warm caches and record summary stats.
 *
 * No external storage required: feeds are generated fresh on each
 * request. The cron tick just logs the summary for monitoring.
 */

import cron from 'node-cron'
import prisma from '../db.js'
import { logger } from '../utils/logger.js'
import { recordCronRun } from '../utils/cron-observability.js'
import { exportGMCFeed, exportMetaCatalog } from '../services/feed/feed-export.service.js'

let scheduledTask: ReturnType<typeof cron.schedule> | null = null

export async function runFeedExportOnce(): Promise<string> {
  const [gmc, meta] = await Promise.all([
    exportGMCFeed(prisma, { limit: 10000 }),
    exportMetaCatalog(prisma, { limit: 10000 }),
  ])

  return [
    `gmc: total=${gmc.summary.total} inStock=${gmc.summary.inStock} suppressed=${gmc.summary.outOfStock}`,
    `meta: total=${meta.summary.total} inStock=${meta.summary.inStock} suppressed=${meta.summary.outOfStock}`,
  ].join(' | ')
}

export async function runFeedExportCron(): Promise<void> {
  try {
    await recordCronRun('feed-export', async () => {
      const summary = await runFeedExportOnce()
      logger.info('feed-export cron: completed', { summary })
      return summary
    })
  } catch (err) {
    logger.error('feed-export cron: failure', {
      error: err instanceof Error ? err.message : String(err),
    })
  }
}

export function startFeedExportCron(): void {
  if (scheduledTask) return
  const schedule = process.env.NEXUS_FEED_EXPORT_SCHEDULE ?? '0 6 * * *'
  scheduledTask = cron.schedule(schedule, () => {
    void runFeedExportCron()
  })
  logger.info('feed-export cron: scheduled', { schedule })
}
