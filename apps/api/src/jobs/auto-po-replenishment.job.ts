/**
 * R.6 — Auto-PO replenishment cron.
 *
 * Schedule: '0 5 * * *' UTC (05:00). Sequenced after sales-ingest
 * (02:00), forecast (03:30), and forecast-accuracy (04:00) so the
 * recommendations the cron sees reflect today's freshly-computed
 * urgency scores.
 *
 * Default-on; opt out via NEXUS_ENABLE_AUTO_PO_CRON=0.
 *
 * Each run writes an AutoPoRunLog row even when no POs are created
 * (zero-row days are still data — proves the cron is firing).
 */

import cron from 'node-cron'
import { logger } from '../utils/logger.js'
import { runAutoPoSweep } from '../services/auto-po.service.js'
import { recordCronRun } from '../utils/cron-observability.js'

let scheduledTask: ReturnType<typeof cron.schedule> | null = null
let lastRunAt: Date | null = null
let lastPosCreated = 0

export async function runAutoPoCronOnce(): Promise<void> {
  try {
    await recordCronRun('auto-po', async () => {
      const r = await runAutoPoSweep({ triggeredBy: 'cron', dryRun: false })
      lastRunAt = new Date()
      lastPosCreated = r.posCreated
      if (r.posCreated > 0 || r.errorCount > 0) {
        logger.info('auto-po cron: completed', {
          posCreated: r.posCreated,
          eligible: r.eligibleCount,
          errors: r.errorCount,
          runLogId: r.runLogId,
        })
      }
      return `${r.posCreated} POs from ${r.eligibleCount} eligible recs (errors=${r.errorCount})`
    })
  } catch (err) {
    logger.error('auto-po cron: failure', {
      error: err instanceof Error ? err.message : String(err),
    })
  }
}

export function startAutoPoCron(): void {
  if (scheduledTask) {
    logger.warn('auto-po cron already started — skipping')
    return
  }
  const schedule = process.env.NEXUS_AUTO_PO_SCHEDULE ?? '0 5 * * *'
  if (!cron.validate(schedule)) {
    logger.error('auto-po cron: invalid schedule', { schedule })
    return
  }
  scheduledTask = cron.schedule(schedule, () => { void runAutoPoCronOnce() })
  logger.info('auto-po cron: scheduled', { schedule })
}

export function stopAutoPoCron(): void {
  if (scheduledTask) {
    scheduledTask.stop()
    scheduledTask = null
  }
}

export function getAutoPoCronStatus(): {
  scheduled: boolean
  lastRunAt: Date | null
  lastPosCreated: number
} {
  return {
    scheduled: scheduledTask !== null,
    lastRunAt,
    lastPosCreated,
  }
}
