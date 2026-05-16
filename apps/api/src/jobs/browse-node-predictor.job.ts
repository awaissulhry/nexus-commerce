/**
 * CE.2 — Browse Node Predictor cron.
 *
 * Runs every 12h under NEXUS_ENABLE_BRAND_BRAIN=1. Sweeps ChannelListing
 * rows where platformAttributes.browseNodeId is missing and predicts the
 * correct node using Claude Haiku. Processes up to 50 listings per tick
 * to stay within token budget; subsequent ticks drain the backlog.
 *
 * Gated by NEXUS_ENABLE_BRAND_BRAIN=1 (shares gate with MB.1 Brand Brain)
 * since both features depend on the AI enrichment pipeline.
 */

import cron from 'node-cron'
import prisma from '../db.js'
import { logger } from '../utils/logger.js'
import { recordCronRun } from '../utils/cron-observability.js'
import { sweepMissingBrowseNodes } from '../services/feed/browse-node-predictor.service.js'

let scheduledTask: ReturnType<typeof cron.schedule> | null = null

export async function runBrowseNodePredictorOnce(): Promise<string> {
  const result = await sweepMissingBrowseNodes(prisma, { channel: 'AMAZON', limit: 50 })
  return `attempted=${result.attempted} succeeded=${result.succeeded} skipped=${result.skipped} errors=${result.errors}`
}

export async function runBrowseNodePredictorCron(): Promise<void> {
  try {
    await recordCronRun('browse-node-predictor', async () => {
      const summary = await runBrowseNodePredictorOnce()
      logger.info('browse-node-predictor cron: completed', { summary })
      return summary
    })
  } catch (err) {
    logger.error('browse-node-predictor cron: failure', {
      error: err instanceof Error ? err.message : String(err),
    })
  }
}

export function startBrowseNodePredictorCron(): void {
  if (!process.env.NEXUS_ENABLE_BRAND_BRAIN) return
  if (scheduledTask) return

  const schedule =
    process.env.NEXUS_BROWSE_NODE_SCHEDULE ?? '0 */12 * * *'

  scheduledTask = cron.schedule(schedule, () => {
    void runBrowseNodePredictorCron()
  })

  logger.info('browse-node-predictor cron: scheduled', { schedule })
}
