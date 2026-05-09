/**
 * F.4.4 — Nightly forecast cron.
 *
 * Runs every day at the configured hour (default 03:30 UTC, after the
 * 02:00 sales-report-ingest finishes) and regenerates 90-day forecasts
 * for every series we've seen demand on in the last 365 days.
 *
 * Pattern mirrors sales-report-ingest.job.ts. Gated behind
 * NEXUS_ENABLE_FORECAST_CRON=1; manual trigger lives at
 * POST /api/fulfillment/forecast/run.
 */

import cron from 'node-cron'
import { generateForecastsForAll } from '../services/forecast.service.js'
import { logger } from '../utils/logger.js'
import { recordCronRun } from '../utils/cron-observability.js'

let scheduledTask: ReturnType<typeof cron.schedule> | null = null

async function runForecastTick(): Promise<void> {
  logger.info('forecast cron: tick')
  try {
    await recordCronRun('forecast', async () => {
      const result = await generateForecastsForAll()
      logger.info('forecast cron: complete', {
        seriesProcessed: result.seriesProcessed,
        rowsWritten: result.rowsWritten,
        durationMs: result.durationMs,
        byRegime: result.byRegime,
        errorCount: result.errors.length,
      })
      return `series=${result.seriesProcessed} rows=${result.rowsWritten} errors=${result.errors.length}`
    })
  } catch (err) {
    logger.error('forecast cron: top-level failure', {
      error: err instanceof Error ? err.message : String(err),
    })
  }
}

export function startForecastCron(): void {
  if (scheduledTask) {
    logger.warn('forecast cron already started — skipping')
    return
  }
  // Default 03:30 UTC daily — gives the 02:00 sales-report-ingest a
  // 90-minute head start so AMAZON_REPORT rows are present before
  // the forecast reads them.
  const schedule = process.env.NEXUS_FORECAST_CRON_SCHEDULE ?? '30 3 * * *'
  if (!cron.validate(schedule)) {
    logger.error('forecast cron: invalid schedule expression', { schedule })
    return
  }
  scheduledTask = cron.schedule(schedule, () => {
    void runForecastTick()
  })
  logger.info('forecast cron: scheduled', { schedule })
}

export function stopForecastCron(): void {
  if (scheduledTask) {
    scheduledTask.stop()
    scheduledTask = null
  }
}

export { runForecastTick }
