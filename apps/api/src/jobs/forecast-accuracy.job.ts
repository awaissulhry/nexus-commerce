/**
 * R.1 — Daily forecast accuracy cron.
 *
 * Sequenced after sales-report-ingest (02:00 UTC) and the forecast
 * generator (03:30 UTC). At 04:00 UTC, every (sku, channel,
 * marketplace) tuple with a DailySalesAggregate row for yesterday is
 * scored against the most recent ReplenishmentForecast that targeted
 * yesterday and was generated BEFORE yesterday started.
 *
 * Idempotent: UPSERTs on (sku, channel, marketplace, day). Re-running
 * the cron during the day is safe.
 *
 * Default-on; opt out via NEXUS_ENABLE_FORECAST_ACCURACY_CRON=0.
 */

import cron from 'node-cron'
import { logger } from '../utils/logger.js'
import { runForecastAccuracySweep } from '../services/forecast-accuracy.service.js'

let scheduledTask: ReturnType<typeof cron.schedule> | null = null
let lastRunAt: Date | null = null
let lastEvaluated = 0

export async function runForecastAccuracyCronOnce(): Promise<void> {
  try {
    const r = await runForecastAccuracySweep()
    lastRunAt = new Date()
    lastEvaluated = r.evaluated
  } catch (err) {
    logger.error('forecast-accuracy cron: failure', {
      error: err instanceof Error ? err.message : String(err),
    })
  }
}

export function startForecastAccuracyCron(): void {
  if (scheduledTask) {
    logger.warn('forecast-accuracy cron already started — skipping')
    return
  }
  const schedule = process.env.NEXUS_FORECAST_ACCURACY_SCHEDULE ?? '0 4 * * *'
  if (!cron.validate(schedule)) {
    logger.error('forecast-accuracy cron: invalid schedule', { schedule })
    return
  }
  scheduledTask = cron.schedule(schedule, () => { void runForecastAccuracyCronOnce() })
  logger.info('forecast-accuracy cron: scheduled', { schedule })
}

export function stopForecastAccuracyCron(): void {
  if (scheduledTask) {
    scheduledTask.stop()
    scheduledTask = null
  }
}

export function getForecastAccuracyCronStatus(): {
  scheduled: boolean
  lastRunAt: Date | null
  lastEvaluated: number
} {
  return {
    scheduled: scheduledTask !== null,
    lastRunAt,
    lastEvaluated,
  }
}
