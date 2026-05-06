/**
 * R.11 — Nightly cron that recomputes per-supplier lead-time σ
 * from the last 365 days of PO receives.
 *
 * Schedule: '0 6 * * *' UTC. After the rest of the replenishment
 * pipeline (sales-ingest 02:00 → forecast 03:30 → forecast-accuracy
 * 04:00 → auto-PO 05:00 → lead-time-stats 06:00). Lead-time stats
 * don't change fast — daily recompute is plenty.
 *
 * Default-on; opt out via NEXUS_ENABLE_LEAD_TIME_STATS_CRON=0.
 */

import cron from 'node-cron'
import { logger } from '../utils/logger.js'
import { recomputeAllLeadTimeStats } from '../services/lead-time-stats.service.js'

let scheduledTask: ReturnType<typeof cron.schedule> | null = null
let lastRunAt: Date | null = null
let lastSummary: Awaited<ReturnType<typeof recomputeAllLeadTimeStats>> | null = null

export async function runLeadTimeStatsCronOnce(): Promise<void> {
  try {
    const r = await recomputeAllLeadTimeStats()
    lastRunAt = new Date()
    lastSummary = r
    if (r.suppliersUpdated > 0 || r.errorCount > 0) {
      logger.info('lead-time-stats cron: completed', r)
    }
  } catch (err) {
    logger.error('lead-time-stats cron: failure', {
      error: err instanceof Error ? err.message : String(err),
    })
  }
}

export function startLeadTimeStatsCron(): void {
  if (scheduledTask) {
    logger.warn('lead-time-stats cron already started — skipping')
    return
  }
  const schedule = process.env.NEXUS_LEAD_TIME_STATS_SCHEDULE ?? '0 6 * * *'
  if (!cron.validate(schedule)) {
    logger.error('lead-time-stats cron: invalid schedule', { schedule })
    return
  }
  scheduledTask = cron.schedule(schedule, () => { void runLeadTimeStatsCronOnce() })
  logger.info('lead-time-stats cron: scheduled', { schedule })
}

export function stopLeadTimeStatsCron(): void {
  if (scheduledTask) {
    scheduledTask.stop()
    scheduledTask = null
  }
}

export function getLeadTimeStatsCronStatus() {
  return {
    scheduled: scheduledTask !== null,
    lastRunAt,
    lastSummary,
  }
}
