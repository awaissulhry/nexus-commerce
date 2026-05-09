/**
 * S.25 — Daily Pan-EU FBA distribution sync cron.
 *
 * Schedule: '0 3 * * *' UTC (03:00 daily). Pulls per-FC inventory
 * detail from SP-API getInventoryDetails and upserts into
 * FbaInventoryDetail. Daily cadence is sufficient — Amazon redistributes
 * stock across FCs slowly, and getInventoryDetails has tighter
 * throttle than the 15-min summary endpoint.
 *
 * Default-on; opt out via NEXUS_ENABLE_FBA_PAN_EU_CRON=0.
 */

import cron from 'node-cron'
import { logger } from '../utils/logger.js'
import {
  syncFbaPanEuInventory,
  fbaPanEuUnconfiguredAdapter,
  type PanEuAdapter,
} from '../services/fba-pan-eu.service.js'
import { recordCronRun } from '../utils/cron-observability.js'

let scheduledTask: ReturnType<typeof cron.schedule> | null = null
let lastRunAt: Date | null = null
let lastSummary: Awaited<ReturnType<typeof syncFbaPanEuInventory>> | null = null

/**
 * Resolve the production adapter. Returns the unconfigured stub
 * until the SP-API getInventoryDetails wrapper lands. The cron
 * detects the stub and skips silently — safe local + sandbox.
 */
function resolveAdapter(): PanEuAdapter {
  if (process.env.AMAZON_FBA_PAN_EU_LIVE === '1') {
    // TODO: wire the real SP-API adapter. Same shape mock tests use.
  }
  return fbaPanEuUnconfiguredAdapter
}

export async function runFbaPanEuSyncOnce(): Promise<void> {
  if (process.env.NEXUS_ENABLE_FBA_PAN_EU_CRON === '0') {
    logger.info('fba-pan-eu cron: disabled via NEXUS_ENABLE_FBA_PAN_EU_CRON=0')
    return
  }
  const adapter = resolveAdapter()
  if (adapter === fbaPanEuUnconfiguredAdapter) {
    logger.info('fba-pan-eu cron: adapter unconfigured — skipping')
    return
  }
  try {
    await recordCronRun('fba-pan-eu-sync', async () => {
      const r = await syncFbaPanEuInventory(adapter)
      lastRunAt = new Date()
      lastSummary = r
      if (r.rowsUpserted > 0 || r.errors.length > 0) {
        logger.info('fba-pan-eu cron: completed', {
          rowsUpserted: r.rowsUpserted,
          rowsCreated: r.rowsCreated,
          rowsUpdated: r.rowsUpdated,
          productsTouched: r.productsTouched,
          errorCount: r.errors.length,
          durationMs: r.durationMs,
        })
      }
      return `upserted=${r.rowsUpserted} created=${r.rowsCreated} updated=${r.rowsUpdated} products=${r.productsTouched} errors=${r.errors.length}`
    })
  } catch (err) {
    logger.error('fba-pan-eu cron: top-level failure', {
      error: err instanceof Error ? err.message : String(err),
    })
  }
}

export function startFbaPanEuSyncCron(): void {
  if (scheduledTask) {
    logger.warn('fba-pan-eu cron already started — skipping')
    return
  }
  const schedule = process.env.NEXUS_FBA_PAN_EU_CRON_SCHEDULE ?? '0 3 * * *'
  if (!cron.validate(schedule)) {
    logger.error('fba-pan-eu cron: invalid schedule', { schedule })
    return
  }
  scheduledTask = cron.schedule(schedule, () => { void runFbaPanEuSyncOnce() })
  logger.info('fba-pan-eu cron: scheduled', { schedule })
}

export function stopFbaPanEuSyncCron(): void {
  if (scheduledTask) {
    scheduledTask.stop()
    scheduledTask = null
  }
}

export function getFbaPanEuSyncStatus() {
  return { scheduled: scheduledTask !== null, lastRunAt, lastSummary }
}
