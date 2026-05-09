/**
 * R.12 — Nightly stockout detector cron.
 *
 * Schedule: '30 6 * * *' UTC. After lead-time-stats (06:00). Walks
 * StockLevel + open StockoutEvents to:
 *   - Open events for levels currently at 0 with no open event
 *     (catches movements that bypassed the synchronous hook).
 *   - Close events whose level is now > 0 (catches restock that
 *     bypassed the hook).
 *   - Refresh running loss estimates for events still open after the
 *     above pass (so the dashboard's "ongoing loss" tile is fresh).
 *
 * Default-on; opt out via NEXUS_ENABLE_STOCKOUT_DETECTOR_CRON=0.
 */

import cron from 'node-cron'
import { logger } from '../utils/logger.js'
import { runStockoutSweep } from '../services/stockout-detector.service.js'
import { recordCronRun } from '../utils/cron-observability.js'

let scheduledTask: ReturnType<typeof cron.schedule> | null = null
let lastRunAt: Date | null = null
let lastSummary: Awaited<ReturnType<typeof runStockoutSweep>> | null = null

export async function runStockoutCronOnce(): Promise<void> {
  try {
    await recordCronRun('stockout-detector', async () => {
      const r = await runStockoutSweep()
      lastRunAt = new Date()
      lastSummary = r
      if (r.opened > 0 || r.closed > 0) {
        logger.info('stockout-detector cron: completed', r)
      }
      return `opened=${r.opened} closed=${r.closed}`
    })
  } catch (err) {
    logger.error('stockout-detector cron: failure', {
      error: err instanceof Error ? err.message : String(err),
    })
  }
}

export function startStockoutDetectorCron(): void {
  if (scheduledTask) {
    logger.warn('stockout-detector cron already started — skipping')
    return
  }
  const schedule = process.env.NEXUS_STOCKOUT_DETECTOR_SCHEDULE ?? '30 6 * * *'
  if (!cron.validate(schedule)) {
    logger.error('stockout-detector cron: invalid schedule', { schedule })
    return
  }
  scheduledTask = cron.schedule(schedule, () => { void runStockoutCronOnce() })
  logger.info('stockout-detector cron: scheduled', { schedule })
}

export function stopStockoutDetectorCron(): void {
  if (scheduledTask) {
    scheduledTask.stop()
    scheduledTask = null
  }
}

export function getStockoutDetectorCronStatus() {
  return {
    scheduled: scheduledTask !== null,
    lastRunAt,
    lastSummary,
  }
}
