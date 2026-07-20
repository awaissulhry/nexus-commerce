/**
 * Incremental eBay orders polling cron (O.2).
 *
 * Mirror of amazon-orders-sync.job.ts. Default schedule: every 15 min
 * — same cadence as Amazon for the same reason: it catches all status
 * transitions on the first re-poll without burning Fulfillment-API
 * quota.
 *
 * Why this exists: until O.2, eBay orders only landed when an operator
 * clicked the "Sync now" button on /api/sync/ebay/orders. Amazon and
 * Shopify both have automated cadences (cron + webhook respectively);
 * eBay was the only revenue channel that could silently age.
 *
 * Connection model: one cron tick fans out across every active eBay
 * ChannelConnection. The service itself filters on isActive, but we
 * enumerate up front so we can aggregate stats per-tick.
 *
 * Cursor logic lives inside ebayOrdersService — it pulls a 7-day
 * window from the Fulfillment API filtered by creationdate, and
 * upserts on (channel='EBAY', channelOrderId) so re-runs are
 * idempotent.
 *
 * Gated behind NEXUS_ENABLE_EBAY_ORDERS_CRON=1 (default-OFF, matching
 * Amazon).
 */

import cron from 'node-cron'
import prisma from '../db.js'
import { ebayOrdersService } from '../services/ebay-orders.service.js'
import { logger } from '../utils/logger.js'
import { recordCronRun } from '../utils/cron-observability.js'

let scheduledTask: ReturnType<typeof cron.schedule> | null = null

async function runOrdersPoll(): Promise<void> {
  let connections: Array<{ id: string; displayName: string | null }> = []
  try {
    connections = await (prisma as any).channelConnection.findMany({
      where: { channelType: 'EBAY', isActive: true },
      select: { id: true, displayName: true },
    })
  } catch (err) {
    logger.error('ebay-orders cron: failed to enumerate connections', {
      error: err instanceof Error ? err.message : String(err),
    })
    return
  }

  if (connections.length === 0) {
    logger.info('ebay-orders cron: no active eBay connections — skipping')
    return
  }

  await recordCronRun('ebay-orders-sync', async () => {
    const totals = {
      connectionsTried: connections.length,
      connectionsOk: 0,
      connectionsPartial: 0,
      connectionsFailed: 0,
      ordersFetched: 0,
      ordersCreated: 0,
      ordersUpdated: 0,
      inventoryDeducted: 0,
    }

    let firstError: string | null = null
    for (const conn of connections) {
      try {
        const result = await ebayOrdersService.syncEbayOrders(conn.id)
        totals.ordersFetched += result.ordersFetched
        totals.ordersCreated += result.ordersCreated
        totals.ordersUpdated += result.ordersUpdated
        totals.inventoryDeducted += result.inventoryDeducted

        if (result.status === 'SUCCESS') totals.connectionsOk++
        else if (result.status === 'PARTIAL') totals.connectionsPartial++
        else totals.connectionsFailed++

        if (result.status !== 'SUCCESS') {
          firstError ??= result.errors[0]?.error ?? null
          logger.warn('ebay-orders cron: connection completed with errors', {
            connectionId: conn.id,
            displayName: conn.displayName,
            status: result.status,
            errors: result.errors.slice(0, 5),
          })
        }
      } catch (err) {
        totals.connectionsFailed++
        firstError ??= err instanceof Error ? err.message : String(err)
        logger.error('ebay-orders cron: connection threw', {
          connectionId: conn.id,
          displayName: conn.displayName,
          error: err instanceof Error ? err.message : String(err),
        })
      }
    }

    logger.info('ebay-orders cron: tick complete', totals)
    // AS.3 — surface the first failure reason in the CronRun summary. The
    // getValidToken defect failed every tick for 7+ days as a bare
    // `failed=1` because per-connection errors only went to logs.
    const errNote = firstError ? ` err="${firstError.slice(0, 120)}"` : ''
    return `connections=${totals.connectionsTried} ok=${totals.connectionsOk} partial=${totals.connectionsPartial} failed=${totals.connectionsFailed} fetched=${totals.ordersFetched} created=${totals.ordersCreated}${errNote}`
  }).catch((err) => {
    logger.error('ebay-orders cron: top-level failure', {
      error: err instanceof Error ? err.message : String(err),
    })
  })
}

export function startEbayOrdersCron(): void {
  if (scheduledTask) {
    logger.warn('ebay-orders cron already started — skipping')
    return
  }

  // RT.3 — default every 5 min (was 15). eBay has NO reliable order push in
  // 2026: SOAP Platform Notifications are best-effort (failed deliveries are
  // never resent; repeated failures make eBay stop sending), so this poll IS
  // the latency floor for eBay sales. Override via NEXUS_EBAY_ORDERS_CRON_SCHEDULE.
  const schedule = process.env.NEXUS_EBAY_ORDERS_CRON_SCHEDULE ?? '*/5 * * * *'

  if (!cron.validate(schedule)) {
    logger.error('ebay-orders cron: invalid schedule expression', { schedule })
    return
  }

  scheduledTask = cron.schedule(schedule, () => {
    void runOrdersPoll()
  })

  logger.info('ebay-orders cron: scheduled', { schedule })
}

export function stopEbayOrdersCron(): void {
  if (scheduledTask) {
    scheduledTask.stop()
    scheduledTask = null
  }
}

export { runOrdersPoll }
