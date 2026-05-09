/**
 * T.8 part 2 — Year-end inventory snapshot cron.
 *
 * Schedule: '0 0 1 1 *' UTC (Jan 1 at 00:00). Snapshots the prior
 * year — runs once per year. Idempotent so re-runs are safe.
 *
 * Default-on; opt out via NEXUS_ENABLE_YEAR_END_SNAPSHOT_CRON=0.
 *
 * Note: the underlying service computes from CURRENT cost-layer
 * state (not historical replay), so the timestamp the snapshot
 * represents — Dec 31 23:59:59 UTC of the prior year — is the
 * canonical Italian fiscal-close moment, but the data captured
 * reflects whatever the layers look like on Jan 1 when the cron
 * fires. For Xavia today this is fine: the Jan-1 layer state is
 * within minutes of Dec 31 close. A future enhancement would
 * replay StockMovement consumes to reconstruct point-in-time.
 */

import cron from 'node-cron'
import { logger } from '../utils/logger.js'
import { snapshotYearEndValuation } from '../services/year-end-snapshot.service.js'
import { recordCronRun } from '../utils/cron-observability.js'

let scheduledTask: ReturnType<typeof cron.schedule> | null = null
let lastRunAt: Date | null = null
let lastSnapshottedYear: number | null = null

export async function runYearEndSnapshotOnce(targetYear?: number): Promise<void> {
  if (process.env.NEXUS_ENABLE_YEAR_END_SNAPSHOT_CRON === '0') {
    logger.info('year-end-snapshot cron: disabled via NEXUS_ENABLE_YEAR_END_SNAPSHOT_CRON=0')
    return
  }
  // When the cron fires on Jan 1, target is the year that just ended.
  const year = targetYear ?? new Date().getUTCFullYear() - 1
  try {
    await recordCronRun('year-end-snapshot', async () => {
      const r = await snapshotYearEndValuation(year, {
        notes: targetYear == null ? 'cron-fired' : `manual replay for ${year}`,
      })
      lastRunAt = new Date()
      lastSnapshottedYear = year
      logger.info('year-end-snapshot cron: completed', {
        year,
        totalUnits: r.total.units,
        totalValueEurCents: r.total.valueEurCents,
        layerCount: r.layerCount,
      })
      return `year=${year} units=${r.total.units} valueEurCents=${r.total.valueEurCents} layers=${r.layerCount}`
    })
  } catch (err) {
    logger.error('year-end-snapshot cron: failure', {
      year,
      error: err instanceof Error ? err.message : String(err),
    })
  }
}

export function startYearEndSnapshotCron(): void {
  if (scheduledTask) {
    logger.warn('year-end-snapshot cron already started — skipping')
    return
  }
  const schedule = process.env.NEXUS_YEAR_END_SNAPSHOT_CRON_SCHEDULE ?? '0 0 1 1 *'
  if (!cron.validate(schedule)) {
    logger.error('year-end-snapshot cron: invalid schedule', { schedule })
    return
  }
  scheduledTask = cron.schedule(schedule, () => { void runYearEndSnapshotOnce() })
  logger.info('year-end-snapshot cron: scheduled', { schedule })
}

export function stopYearEndSnapshotCron(): void {
  if (scheduledTask) {
    scheduledTask.stop()
    scheduledTask = null
  }
}

export function getYearEndSnapshotCronStatus() {
  return { scheduled: scheduledTask !== null, lastRunAt, lastSnapshottedYear }
}
