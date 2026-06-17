/**
 * ACP.4a — Listing-Quality Keeper cron.
 *
 * Schedule: '45 6 * * *' UTC (after the morning sync/stats jobs). Runs
 * the autonomous Listing-Quality Keeper once: it scans active products
 * for content gaps and QUEUES reversible apply-content proposals into the
 * approval inbox. Nothing is applied — an operator approves each one.
 *
 * Default-on; opt out with NEXUS_ENABLE_LISTING_QUALITY_KEEPER=0. The
 * per-run cap + dedupe live in the agent, so the worst case is a handful
 * of pending proposals a day.
 */

import cron from 'node-cron'
import { logger } from '../utils/logger.js'
import { recordCronRun } from '../utils/cron-observability.js'
import { runAutonomousAgent } from '../services/agents/autonomous-agent.service.js'

const JOB = 'listing-quality-keeper'
const SCHEDULE = '45 6 * * *'

let scheduledTask: ReturnType<typeof cron.schedule> | null = null

export async function runListingQualityKeeperCron(): Promise<void> {
  try {
    await recordCronRun(JOB, async () => {
      const r = await runAutonomousAgent('listing-quality-keeper', 'schedule')
      if (!r.ok) throw new Error(r.error ?? 'agent run failed')
      const s = r.result
      if (s && s.proposed > 0)
        logger.info('listing-quality-keeper cron: proposals queued', {
          proposed: s.proposed,
          flagged: s.flagged,
          scanned: s.scanned,
        })
      return s
        ? `scanned=${s.scanned} flagged=${s.flagged} proposed=${s.proposed} skipped=${s.skippedExisting} errors=${s.errors}`
        : 'no result'
    })
  } catch (err) {
    logger.error('listing-quality-keeper cron: failure', {
      error: err instanceof Error ? err.message : String(err),
    })
  }
}

export function startListingQualityKeeperCron(): void {
  if (process.env.NEXUS_ENABLE_LISTING_QUALITY_KEEPER === '0') {
    logger.info('listing-quality-keeper cron: disabled via env')
    return
  }
  if (scheduledTask) return
  scheduledTask = cron.schedule(SCHEDULE, () => {
    void runListingQualityKeeperCron()
  })
  logger.info(`listing-quality-keeper cron: scheduled (${SCHEDULE} UTC)`)
}
