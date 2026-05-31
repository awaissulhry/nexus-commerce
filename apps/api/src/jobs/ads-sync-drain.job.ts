/**
 * Apex A.2c — ads-sync auto-drain (Redis-free).
 *
 * Live ad bid/budget/state mutations land in OutboundSyncQueue and are nudged
 * onto the BullMQ ads-sync worker via enqueueBullMQJob. When Redis is
 * unreachable (as on prod) that worker can't run, so queued rows would sit
 * PENDING forever and live writes would only flow via a manual drain trigger.
 *
 * This cron calls drainAdsSyncOnce — which polls OutboundSyncQueue directly
 * (no Redis) and pushes each ready row (holdUntil elapsed) through the ads
 * dispatcher + checkAdsWriteGate. So autonomous bidding works regardless of
 * Redis health, and every write is still gated (env live + connection
 * production/writesEnabledAt + per-campaign allowlist + guardrails). The grace
 * window is preserved (held rows skipped until holdUntil passes), so the
 * cancel-undo affordance still works.
 *
 * Gated with the other ads crons (NEXUS_ENABLE_AMAZON_ADS_CRON=1) and
 * registered in CRON_REGISTRY for manual triggering.
 */

import cron from 'node-cron'
import { logger } from '../utils/logger.js'
import { recordCronRun } from '../utils/cron-observability.js'

let scheduledTask: ReturnType<typeof cron.schedule> | null = null

export async function runAdsSyncDrainCron(): Promise<void> {
  try {
    await recordCronRun('drain-ads-sync', async () => {
      const { drainAdsSyncOnce } = await import('../workers/ads-sync.worker.js')
      const r = await drainAdsSyncOnce(100)
      return `processed=${r.processed}`
    })
  } catch (err) {
    logger.error('drain-ads-sync cron: failure', { error: err instanceof Error ? err.message : String(err) })
  }
}

export function startAdsSyncDrainCron(): void {
  if (scheduledTask) {
    logger.warn('drain-ads-sync cron already started')
    return
  }
  // Every minute — the 5-min grace window is the real delay; this picks up
  // rows promptly once their hold elapses, even with Redis/BullMQ down.
  scheduledTask = cron.schedule('* * * * *', () => void runAdsSyncDrainCron())
  logger.info('drain-ads-sync cron scheduled (* * * * *)')
}
