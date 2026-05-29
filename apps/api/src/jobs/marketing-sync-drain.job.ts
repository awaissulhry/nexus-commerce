/**
 * UM-series (P5 follow-up) — marketing-sync auto-drain.
 *
 * P5 shipped enqueueCampaignMutation + drainMarketingSyncOnce but only an
 * on-demand drain endpoint, so queued MKT_* mutations sat PENDING after
 * their grace window expired and never finalized. This cron drains them on
 * a short interval: every ready row (holdUntil elapsed) is gate-checked and
 * sandbox-finalized or live-dispatched, and its CampaignAction moves
 * PENDING → SUCCESS/FAILED. The grace window is preserved (held rows are
 * skipped until holdUntil passes), so the cancel-undo affordance still works.
 *
 * Gated with the other marketing crons (NEXUS_ENABLE_AMAZON_ADS_CRON=1) and
 * registered in CRON_REGISTRY for manual triggering.
 */

import cron from 'node-cron'
import { logger } from '../utils/logger.js'
import { recordCronRun } from '../utils/cron-observability.js'

let scheduledTask: ReturnType<typeof cron.schedule> | null = null

export async function runMarketingSyncDrainCron(): Promise<void> {
  try {
    await recordCronRun('marketing-sync-drain', async () => {
      const { drainMarketingSyncOnce } = await import('../services/marketing/marketing-mutation.service.js')
      const r = await drainMarketingSyncOnce(100)
      return `processed=${r.processed}`
    })
  } catch (err) {
    logger.error('marketing-sync-drain cron: failure', { error: err instanceof Error ? err.message : String(err) })
  }
}

export function startMarketingSyncDrainCron(): void {
  if (scheduledTask) {
    logger.warn('marketing-sync-drain cron already started')
    return
  }
  // Every minute — the grace window (5 min) is the real delay; this just
  // picks up rows promptly once their hold elapses.
  scheduledTask = cron.schedule('* * * * *', () => void runMarketingSyncDrainCron())
  logger.info('marketing-sync-drain cron scheduled (* * * * *)')
}
