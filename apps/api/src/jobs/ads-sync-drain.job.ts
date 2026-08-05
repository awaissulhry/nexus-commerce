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

/**
 * ACR.1.2d — the tick's work AND its summary, without the CronRun wrapper.
 *
 * Extracted so the manual-trigger registry can call this directly. Registering the `*Cron`
 * form instead writes TWO CronRun rows per hand-run — the trigger route opens its own
 * `recordCronRun`, and so does the wrapper below — one labelled `manual` carrying nothing
 * and a nested one labelled `cron` carrying the real numbers. The Levers drawer reads
 * exactly this table, so a hand-run appeared twice, mislabelled.
 */
export async function runAdsSyncDrainOnce(): Promise<string> {
  const { drainAdsSyncOnce } = await import('../workers/ads-sync.worker.js')
  const r = await drainAdsSyncOnce(100)
  // AX-ZD.1 — reclaim/dead-letter counts belong in the summary an operator
  // actually reads. A sweep that quietly dead-letters a bid change is the
  // same silent failure this whole phase exists to remove.
  const swept = r.reclaimed || r.deadLettered
    ? ` reclaimed=${r.reclaimed} deadLettered=${r.deadLettered}`
    : ''
  return `processed=${r.processed}${swept}`
}

export async function runAdsSyncDrainCron(): Promise<void> {
  try {
    await recordCronRun('drain-ads-sync', runAdsSyncDrainOnce)
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
