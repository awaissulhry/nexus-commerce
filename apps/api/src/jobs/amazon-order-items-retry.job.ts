/**
 * DA-RT.9 — OrderItem.price upstream retry.
 *
 * Closes the upstream gap that GS-RT.7 only patched at the dashboard
 * layer: when Amazon SP-API getOrderItems returns no ItemPrice at
 * ingest time, the OrderItem row sits at price=0 forever. Subsequent
 * `backfillZeroTotals` calls (GS-RT.2 cron / GS-RT.4 push / GS-RT.5
 * script) then can't recover via the Tier 2 OrderItem.price fallback
 * because the items themselves are also 0.
 *
 * This cron picks up the slack: walks Order/OrderItem joins where the
 * order is recent enough to still be in SP-API's hot cache (default
 * 30 days), at least one item has price=0, and re-fetches getOrderItems
 * for the parent order. If Amazon now returns real prices (typical
 * after 24-48h on PENDING transitions), updates the OrderItem rows
 * AND triggers a sales-aggregate refresh + zero-totals backfill so
 * downstream stores catch up automatically.
 *
 * Schedule
 * --------
 * Every 2h by default. SP-API getOrderItems is 0.5 req/s burst 30 —
 * 50 orders per tick uses 50 × ~50ms = 2.5s of API budget. Plenty.
 *
 * Gated behind NEXUS_ENABLE_AMAZON_ORDER_ITEMS_RETRY=1 (default OFF).
 */

import cron from 'node-cron'
import prisma from '../db.js'
import { logger } from '../utils/logger.js'
import { recordCronRun } from '../utils/cron-observability.js'
import { amazonOrdersService } from '../services/amazon-orders.service.js'

let scheduledTask: ReturnType<typeof cron.schedule> | null = null

interface RetryResult {
  scanned: number
  ordersRequeried: number
  itemsRepaired: number
  ordersSkipped: number
  errors: number
}

export async function runAmazonOrderItemsRetry(): Promise<void> {
  if (!amazonOrdersService.isConfigured()) {
    logger.warn('amazon-order-items-retry: SP-API not configured — skipping')
    return
  }
  try {
    await recordCronRun('amazon-order-items-retry', async () => {
      const lookbackDays = Number(
        process.env.NEXUS_AMAZON_ORDER_ITEMS_RETRY_LOOKBACK_DAYS ?? 30,
      )
      const limit = Number(
        process.env.NEXUS_AMAZON_ORDER_ITEMS_RETRY_LIMIT ?? 50,
      )
      const lookback =
        Number.isFinite(lookbackDays) && lookbackDays > 0 ? lookbackDays : 30
      const batchLimit =
        Number.isFinite(limit) && limit > 0 ? limit : 50

      // Orders that have at least one €0-price item AND are recent
      // enough to still be in SP-API hot cache. Ordered by
      // purchaseDate ASC so the oldest stuck rows clear first.
      // EXISTS subquery avoids the duplicate-row problem JOIN+DISTINCT
      // would create — Postgres also forbids ORDER BY on non-SELECTed
      // columns under DISTINCT, so EXISTS keeps the SQL trivially valid.
      const since = new Date(Date.now() - lookback * 24 * 60 * 60_000)
      const stuckRows = await prisma.$queryRaw<Array<{
        orderId: string
        channelOrderId: string
      }>>`
        SELECT o.id AS "orderId", o."channelOrderId"
        FROM "Order" o
        WHERE o."channel" = 'AMAZON'
          AND o."deletedAt" IS NULL
          AND o."status" != 'CANCELLED'
          AND o."purchaseDate" >= ${since}
          AND EXISTS (
            SELECT 1 FROM "OrderItem" oi
            WHERE oi."orderId" = o.id
              AND (oi."price" = 0 OR oi."price" IS NULL)
          )
        ORDER BY o."purchaseDate" ASC
        LIMIT ${batchLimit}
      `

      const result: RetryResult = {
        scanned: stuckRows.length,
        ordersRequeried: 0,
        itemsRepaired: 0,
        ordersSkipped: 0,
        errors: 0,
      }

      // After we've repaired items, trigger a single batched
      // backfillZeroTotals across the affected window — that path
      // already does the OrderItem.price → totalPrice fallback +
      // fires sales-aggregate refresh via DA-RT.6.
      const repairedOrderIds: string[] = []

      // Lazy-instantiate the AmazonService so jobs that never run
      // this cron (gate OFF) don't pay the bundling cost. The
      // amazonService instance in amazon-orders.service.ts is
      // module-local; making our own here keeps the dependency
      // explicit + avoids exporting the singleton.
      const { AmazonService } = await import('../services/marketplaces/amazon.service.js')
      const amazonService = new AmazonService()

      for (const row of stuckRows) {
        try {
          const items = await amazonService.fetchOrderItems(row.channelOrderId)
          if (!items || items.length === 0) {
            result.ordersSkipped += 1
            continue
          }
          let updatedAny = false
          for (const it of items) {
            if (!it.ItemPrice?.Amount) continue
            const newPrice = Number(it.ItemPrice.Amount)
            if (!Number.isFinite(newPrice) || newPrice <= 0) continue
            // Update our row only if the existing price is 0/null —
            // never overwrite a confirmed price.
            const updated = await prisma.orderItem.updateMany({
              where: {
                orderId: row.orderId,
                externalLineItemId: it.OrderItemId,
                OR: [{ price: 0 }, { price: null as any }],
              },
              data: { price: newPrice },
            })
            if (updated.count > 0) {
              result.itemsRepaired += updated.count
              updatedAny = true
            }
          }
          if (updatedAny) {
            result.ordersRequeried += 1
            repairedOrderIds.push(row.orderId)
          } else {
            result.ordersSkipped += 1
          }
        } catch (err) {
          result.errors += 1
          logger.warn('amazon-order-items-retry: per-order failure', {
            orderId: row.orderId,
            channelOrderId: row.channelOrderId,
            error: err instanceof Error ? err.message : String(err),
          })
        }
      }

      // Trigger one batched zero-totals backfill so the repaired
      // OrderItem.price values flow into Order.totalPrice via the
      // GS-RT.7 Tier-2 fallback. DA-RT.6 then auto-refreshes the
      // sales-aggregate. Single roundtrip regardless of N orders.
      if (repairedOrderIds.length > 0) {
        try {
          await amazonOrdersService.backfillZeroTotals({
            limit: repairedOrderIds.length,
            includePending: true,
            channelOrderIds: stuckRows
              .filter((r) => repairedOrderIds.includes(r.orderId))
              .map((r) => r.channelOrderId),
          })
        } catch (backfillErr) {
          // Non-fatal — the OrderItem repair itself succeeded; the
          // next scheduled backfill cron will catch up.
          logger.warn('amazon-order-items-retry: batched backfill nudge failed', {
            error: backfillErr instanceof Error ? backfillErr.message : String(backfillErr),
            repairedOrderCount: repairedOrderIds.length,
          })
        }
      }

      if (result.errors > 0 || result.itemsRepaired > 0) {
        logger.info('amazon-order-items-retry: complete', result)
      }
      return `scanned=${result.scanned} requeried=${result.ordersRequeried} itemsRepaired=${result.itemsRepaired} skipped=${result.ordersSkipped} errors=${result.errors}`
    })
  } catch (err) {
    logger.error('amazon-order-items-retry: top-level failure', {
      error: err instanceof Error ? err.message : String(err),
    })
  }
}

export function startAmazonOrderItemsRetryCron(): void {
  if (scheduledTask) {
    logger.warn('amazon-order-items-retry cron already started — skipping')
    return
  }
  // Default every 2 hours. SP-API getOrderItems quota is generous
  // (0.5 req/s burst 30); 50 orders per tick = ~50 API calls = ~100s
  // worst case under burst, fits comfortably in the window.
  const schedule = process.env.NEXUS_AMAZON_ORDER_ITEMS_RETRY_SCHEDULE ?? '0 */2 * * *'
  if (!cron.validate(schedule)) {
    logger.error('amazon-order-items-retry cron: invalid schedule', { schedule })
    return
  }
  scheduledTask = cron.schedule(schedule, () => {
    void runAmazonOrderItemsRetry()
  })
  logger.info('amazon-order-items-retry cron: started', { schedule })
}
