/**
 * S.16 — Weekly ABC classification cron.
 *
 * Schedule: '0 4 * * 1' UTC (Mondays at 04:00). Late enough that the
 * Sunday daily-aggregation has settled but early enough that the
 * operator's Monday-morning view sees fresh bands.
 *
 * Default-on; opt out via NEXUS_ENABLE_ABC_CRON=0.
 */

import cron from 'node-cron'
import { logger } from '../utils/logger.js'
import { recompute } from '../services/abc-classification.service.js'
import { recordCronRun } from '../utils/cron-observability.js'

let scheduledTask: ReturnType<typeof cron.schedule> | null = null
let lastRunAt: Date | null = null
let lastSummary: Awaited<ReturnType<typeof recompute>> | null = null

export async function runAbcCronOnce(): Promise<void> {
  if (process.env.NEXUS_ENABLE_ABC_CRON === '0') {
    logger.info('abc-classification cron: disabled via NEXUS_ENABLE_ABC_CRON=0')
    return
  }
  try {
    await recordCronRun('abc-classification', async () => {
      const r = await recompute()
      lastRunAt = new Date()
      lastSummary = r
      logger.info('abc-classification cron: completed', {
        productsTracked: r.totals.productsTracked,
        A: r.totals.skusInA,
        B: r.totals.skusInB,
        C: r.totals.skusInC,
        D: r.totals.skusInD,
        durationMs: r.durationMs,
      })
      return `tracked=${r.totals.productsTracked} A=${r.totals.skusInA} B=${r.totals.skusInB} C=${r.totals.skusInC} D=${r.totals.skusInD}`
    })
  } catch (err) {
    logger.error('abc-classification cron: failure', {
      error: err instanceof Error ? err.message : String(err),
    })
  }
}

export function startAbcClassificationCron(): void {
  if (scheduledTask) {
    logger.warn('abc-classification cron already started — skipping')
    return
  }
  const schedule = process.env.NEXUS_ABC_CRON_SCHEDULE ?? '0 4 * * 1'
  if (!cron.validate(schedule)) {
    logger.error('abc-classification cron: invalid schedule', { schedule })
    return
  }
  scheduledTask = cron.schedule(schedule, () => { void runAbcCronOnce() })
  logger.info('abc-classification cron: scheduled', { schedule })
}

export function stopAbcClassificationCron(): void {
  if (scheduledTask) {
    scheduledTask.stop()
    scheduledTask = null
  }
}

export function getAbcClassificationCronStatus() {
  return {
    scheduled: scheduledTask !== null,
    lastRunAt,
    lastSummary,
  }
}
