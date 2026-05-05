/**
 * Incremental Amazon orders polling cron.
 *
 * Default schedule: every 15 min. Why 15:
 *   - SP-API getOrders quota is 0.0167 req/s burst 20 (≈1 req/min sustained).
 *   - Most Xavia orders take >15 min to move PENDING → SHIPPED, so this
 *     pace catches all status transitions on the first re-poll.
 *   - Tighter (every minute) wastes the throttle bucket without adding
 *     business signal; looser (hourly) means /dashboard counts lag.
 *
 * Cursor logic mirrors the manual route POST /api/amazon/orders/sync
 * with no body: derive `since` from MAX(Order.purchaseDate WHERE channel='AMAZON'),
 * fall back to a 30-day backfill if no Amazon orders exist yet (first run).
 *
 * Gated behind NEXUS_ENABLE_AMAZON_ORDERS_CRON=1.
 */

import cron from 'node-cron'
import { amazonOrdersService } from '../services/amazon-orders.service.js'
import { logger } from '../utils/logger.js'

let scheduledTask: ReturnType<typeof cron.schedule> | null = null

async function runOrdersPoll(): Promise<void> {
  if (!amazonOrdersService.isConfigured()) {
    logger.warn('amazon-orders cron: Amazon SP-API not configured — skipping')
    return
  }

  try {
    const latest = await amazonOrdersService.getLatestPurchaseDate()
    const summary = latest
      ? await amazonOrdersService.syncNewOrders(latest)
      : await amazonOrdersService.syncAllOrders({ daysBack: 30 })

    if (summary.ordersFailed > 0 || summary.itemsFailed > 0) {
      logger.warn('amazon-orders cron: completed with failures', {
        cursor: summary.cursor,
        ordersFetched: summary.ordersFetched,
        ordersUpserted: summary.ordersUpserted,
        ordersFailed: summary.ordersFailed,
        itemsFailed: summary.itemsFailed,
      })
    }
    // Success-case logging is already emitted by amazonOrdersService.runSync().
  } catch (err) {
    logger.error('amazon-orders cron: top-level failure', {
      error: err instanceof Error ? err.message : String(err),
    })
  }
}

export function startAmazonOrdersCron(): void {
  if (scheduledTask) {
    logger.warn('amazon-orders cron already started — skipping')
    return
  }

  // Default every 15 min. Override via NEXUS_AMAZON_ORDERS_CRON_SCHEDULE.
  const schedule = process.env.NEXUS_AMAZON_ORDERS_CRON_SCHEDULE ?? '*/15 * * * *'

  if (!cron.validate(schedule)) {
    logger.error('amazon-orders cron: invalid schedule expression', { schedule })
    return
  }

  scheduledTask = cron.schedule(schedule, () => {
    void runOrdersPoll()
  })

  logger.info('amazon-orders cron: scheduled', { schedule })
}

export function stopAmazonOrdersCron(): void {
  if (scheduledTask) {
    scheduledTask.stop()
    scheduledTask = null
  }
}

export { runOrdersPoll }
