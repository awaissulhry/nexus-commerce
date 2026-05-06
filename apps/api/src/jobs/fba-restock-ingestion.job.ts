/**
 * R.8 — Daily cron that pulls Amazon's FBA Restock Inventory
 * Recommendations report and stages it for the recommendation engine
 * cross-check.
 *
 * Schedule: '0 4 * * *' UTC. Runs after orders-sync (02:00) and
 * sales aggregation (03:00) so today's Amazon view is anchored to
 * the latest demand snapshot, but before forecast-accuracy (04:00)
 * so any cross-checks downstream see today's data.
 *
 * Default-on; opt out via NEXUS_ENABLE_FBA_RESTOCK_CRON=0.
 * Marketplace list comes from FBA_RESTOCK_MARKETPLACES env (default
 * IT,DE,FR,ES,NL).
 */

import cron from 'node-cron'
import { logger } from '../utils/logger.js'
import {
  ingestRestockReportsForAllMarketplaces,
  type IngestionResult,
} from '../services/fba-restock.service.js'

let scheduledTask: ReturnType<typeof cron.schedule> | null = null
let lastRunAt: Date | null = null
let lastResults: IngestionResult[] | null = null

export async function runFbaRestockCronOnce(): Promise<void> {
  try {
    const results = await ingestRestockReportsForAllMarketplaces('cron')
    lastRunAt = new Date()
    lastResults = results
    const fatal = results.filter((r) => r.status === 'FATAL').length
    const totalRows = results.reduce((s, r) => s + r.rowCount, 0)
    logger.info('fba-restock cron: completed', {
      marketplacesProcessed: results.length,
      totalRows,
      fatalCount: fatal,
    })
  } catch (err) {
    logger.error('fba-restock cron: failure', {
      error: err instanceof Error ? err.message : String(err),
    })
  }
}

export function startFbaRestockCron(): void {
  if (scheduledTask) {
    logger.warn('fba-restock cron already started — skipping')
    return
  }
  if (process.env.NEXUS_ENABLE_FBA_RESTOCK_CRON === '0') {
    logger.info('fba-restock cron: disabled via env')
    return
  }
  const schedule = process.env.NEXUS_FBA_RESTOCK_SCHEDULE ?? '0 4 * * *'
  if (!cron.validate(schedule)) {
    logger.error('fba-restock cron: invalid schedule', { schedule })
    return
  }
  scheduledTask = cron.schedule(schedule, () => { void runFbaRestockCronOnce() })
  logger.info('fba-restock cron: scheduled', { schedule })
}

export function stopFbaRestockCron(): void {
  if (scheduledTask) {
    scheduledTask.stop()
    scheduledTask = null
  }
}

export function getFbaRestockCronStatus() {
  return {
    scheduled: scheduledTask !== null,
    lastRunAt,
    lastResults,
  }
}
