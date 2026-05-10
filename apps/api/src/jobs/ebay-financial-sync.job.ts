/**
 * eBay Financial Events daily sync cron.
 * Pulls yesterday's eBay Sell Finances transactions, matches to orders,
 * writes FinancialTransaction rows. Runs at 03:30 UTC daily.
 * Gated behind NEXUS_ENABLE_EBAY_FINANCIAL_CRON=1.
 */

import cron from 'node-cron'
import { syncEbayYesterdayFinancials } from '../services/ebay-financial-events.service.js'
import { logger } from '../utils/logger.js'
import { recordCronRun } from '../utils/cron-observability.js'

let scheduledTask: ReturnType<typeof cron.schedule> | null = null

async function runEbayFinancialSync(): Promise<void> {
  try {
    await recordCronRun('ebay-financial-sync', async () => {
      const s = await syncEbayYesterdayFinancials()
      return `fetched=${s.txFetched} created=${s.txCreated} skipped=${s.txSkipped} matched=${s.ordersMatched} ms=${s.durationMs}`
    })
  } catch (err) {
    logger.error('ebay-financial-sync cron: failure', {
      error: err instanceof Error ? err.message : String(err),
    })
  }
}

export function startEbayFinancialSyncCron(): void {
  if (scheduledTask) return
  const schedule = process.env.NEXUS_EBAY_FINANCIAL_CRON_SCHEDULE ?? '30 3 * * *'
  if (!cron.validate(schedule)) { logger.error('ebay-financial-sync: invalid schedule', { schedule }); return }
  scheduledTask = cron.schedule(schedule, () => { void runEbayFinancialSync() })
  logger.info('ebay-financial-sync cron: scheduled', { schedule })
}

export function stopEbayFinancialSyncCron(): void {
  if (scheduledTask) { scheduledTask.stop(); scheduledTask = null }
}

export { runEbayFinancialSync }
