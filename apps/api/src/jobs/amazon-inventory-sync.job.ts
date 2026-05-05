/**
 * FBA inventory polling cron — full sweep of getInventorySummaries
 * every 15 minutes.
 *
 * Why 15 min:
 *   - SP-API getInventorySummaries throttle is 2 req/s burst 2; a full
 *     sweep on a 200-SKU catalog is one request, so the throttle is
 *     never the constraint.
 *   - 15 min matches the orders polling cron — fresh-enough for
 *     /products to reflect FBA stock without thrashing.
 *   - Tighter doesn't help (Amazon's own inventory endpoint refresh
 *     cadence is ~5-10 min); looser means /dashboard counts go stale.
 *
 * Coverage: FBA only. MFN/FBM SKUs are NOT touched by this cron — see
 * amazon-inventory.service.ts for the safety contract.
 *
 * Gated behind NEXUS_ENABLE_AMAZON_INVENTORY_CRON=1.
 */

import cron from 'node-cron'
import { amazonInventoryService } from '../services/amazon-inventory.service.js'
import { logger } from '../utils/logger.js'

let scheduledTask: ReturnType<typeof cron.schedule> | null = null

async function runInventorySweep(): Promise<void> {
  if (!amazonInventoryService.isConfigured()) {
    logger.warn('amazon-inventory cron: Amazon SP-API not configured — skipping')
    return
  }

  try {
    const summary = await amazonInventoryService.syncFBAInventory()
    if (summary.errors.length > 0) {
      logger.warn('amazon-inventory cron: completed with errors', {
        marketplaceId: summary.marketplaceId,
        rowsFetched: summary.rowsFetched,
        productsUpdated: summary.productsUpdated,
        errorCount: summary.errors.length,
        firstErrors: summary.errors.slice(0, 3),
      })
    }
    if (summary.skusNotFoundInDb > 0) {
      logger.warn('amazon-inventory cron: some SKUs absent from local DB', {
        skusNotFoundInDb: summary.skusNotFoundInDb,
        sample: summary.unmatchedSampleSkus,
      })
    }
    // Success-case logging is already emitted by the service.
  } catch (err) {
    logger.error('amazon-inventory cron: top-level failure', {
      error: err instanceof Error ? err.message : String(err),
    })
  }
}

export function startAmazonInventoryCron(): void {
  if (scheduledTask) {
    logger.warn('amazon-inventory cron already started — skipping')
    return
  }

  // Default every 15 min. Override via NEXUS_AMAZON_INVENTORY_CRON_SCHEDULE.
  const schedule = process.env.NEXUS_AMAZON_INVENTORY_CRON_SCHEDULE ?? '*/15 * * * *'

  if (!cron.validate(schedule)) {
    logger.error('amazon-inventory cron: invalid schedule expression', { schedule })
    return
  }

  scheduledTask = cron.schedule(schedule, () => {
    void runInventorySweep()
  })

  logger.info('amazon-inventory cron: scheduled', { schedule })
}

export function stopAmazonInventoryCron(): void {
  if (scheduledTask) {
    scheduledTask.stop()
    scheduledTask = null
  }
}

export { runInventorySweep }
