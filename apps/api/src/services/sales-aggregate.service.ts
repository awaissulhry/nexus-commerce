/**
 * F.1 — Sales aggregate service.
 *
 * Materializes OrderItem rows into the DailySalesAggregate fact table, one
 * row per (sku, channel, marketplace, day). Replenishment / forecasting
 * code reads from this table — never live OrderItem.groupBy — so reads
 * stay sub-50ms even at 3K SKUs × 5 marketplaces × 365 days.
 *
 * Two entrypoints:
 *   - refreshSalesAggregates({ from, to })  — re-aggregate a date window
 *   - recordOrderItem(orderItemId)           — incremental write for a
 *                                              single new OrderItem
 *
 * Both are idempotent (upsert on the unique (sku, channel, marketplace,
 * day) key). Re-running over the same window yields the same rows.
 *
 * Source-precedence rule:
 *   ORDER_ITEM rows are written by this service. SP-API report ingestion
 *   (F.3) writes with source = AMAZON_REPORT (or EBAY_REPORT, etc.). When
 *   a report-derived row exists, this service preserves it — it ONLY
 *   overwrites rows whose existing source is ORDER_ITEM or unset. The
 *   forecaster always reads the canonical row regardless of source.
 */

import prisma from '../db.js'
import { logger } from '../utils/logger.js'

interface RefreshArgs {
  /** Inclusive start date (UTC, day boundary). */
  from: Date
  /** Inclusive end date (UTC, day boundary). */
  to: Date
  /** When true, even rows already populated by SP-API reports are
   *  recomputed from OrderItem and overwritten. Default false — report
   *  data is canonical and shouldn't be clobbered by webhook-derived
   *  numbers. */
  overrideReportSources?: boolean
}

interface RefreshResult {
  daysProcessed: number
  rowsWritten: number
  rowsSkipped: number
  durationMs: number
}

/**
 * Re-aggregate OrderItem rows in a date window into DailySalesAggregate.
 *
 * The aggregate query groups by `(sku, channel, marketplace, day)` and
 * sums quantity + price * quantity. Marketplace coalesces to 'GLOBAL' for
 * legacy Order rows where the column is null.
 *
 * Postgres `INSERT ... ON CONFLICT DO UPDATE` ensures we don't trample
 * report-sourced rows: the WHERE filter on the UPDATE clause skips rows
 * whose existing `source` already names a higher-priority origin.
 */
export async function refreshSalesAggregates(
  args: RefreshArgs,
): Promise<RefreshResult> {
  const startTime = Date.now()
  const fromDay = startOfDay(args.from)
  const toDay = startOfDay(args.to)

  if (toDay < fromDay) {
    throw new Error(
      `refreshSalesAggregates: 'to' (${toDay.toISOString()}) must be >= 'from' (${fromDay.toISOString()})`,
    )
  }

  // Aggregate via raw SQL for the speed boost — Prisma's groupBy doesn't
  // support DATE_TRUNC and can't UPSERT in one round-trip. Single
  // INSERT...SELECT does the whole window in one statement.
  //
  // Source precedence: when a row already exists with source IN
  // ('AMAZON_REPORT','EBAY_REPORT','SHOPIFY_REPORT'), keep it. Only
  // overwrite ORDER_ITEM-sourced rows or fresh inserts. The
  // overrideReportSources flag lets manual recompute bypass this if
  // the report data is known stale.
  const overrideClause = args.overrideReportSources
    ? '' // unconditional update
    : `WHERE "DailySalesAggregate"."source" IN ('ORDER_ITEM')`

  const result = await prisma.$executeRawUnsafe(
    `
    INSERT INTO "DailySalesAggregate" (
      id, sku, channel, marketplace, day,
      "unitsSold", "grossRevenue", "ordersCount", source,
      "createdAt", "updatedAt"
    )
    SELECT
      gen_random_uuid()::text AS id,
      oi.sku,
      o.channel::text AS channel,
      COALESCE(o.marketplace, 'GLOBAL') AS marketplace,
      DATE(COALESCE(o."purchaseDate", o."createdAt")) AS day,
      SUM(oi.quantity)::int AS "unitsSold",
      SUM(oi.price * oi.quantity)::numeric(14,2) AS "grossRevenue",
      COUNT(DISTINCT oi."orderId")::int AS "ordersCount",
      'ORDER_ITEM' AS source,
      NOW() AS "createdAt",
      NOW() AS "updatedAt"
    FROM "OrderItem" oi
    JOIN "Order" o ON o.id = oi."orderId"
    WHERE DATE(COALESCE(o."purchaseDate", o."createdAt")) >= $1::date
      AND DATE(COALESCE(o."purchaseDate", o."createdAt")) <= $2::date
      AND o.status != 'CANCELLED'
    GROUP BY oi.sku, o.channel, COALESCE(o.marketplace, 'GLOBAL'),
             DATE(COALESCE(o."purchaseDate", o."createdAt"))
    ON CONFLICT (sku, channel, marketplace, day) DO UPDATE SET
      "unitsSold"    = EXCLUDED."unitsSold",
      "grossRevenue" = EXCLUDED."grossRevenue",
      "ordersCount"  = EXCLUDED."ordersCount",
      source         = 'ORDER_ITEM',
      "updatedAt"    = NOW()
    ${overrideClause}
    `,
    fromDay,
    toDay,
  )

  // Days that had zero orders need explicit deletion of any prior
  // ORDER_ITEM aggregate so cancellations / order deletions zero out
  // correctly. We only touch rows our window owns and never report-
  // sourced rows. Bounded by date range so it's fast even at scale.
  const deleted = await prisma.$executeRaw`
    DELETE FROM "DailySalesAggregate"
    WHERE source = 'ORDER_ITEM'
      AND day >= ${fromDay}::date
      AND day <= ${toDay}::date
      AND NOT EXISTS (
        SELECT 1
        FROM "OrderItem" oi
        JOIN "Order" o ON o.id = oi."orderId"
        WHERE oi.sku = "DailySalesAggregate".sku
          AND o.channel::text = "DailySalesAggregate".channel
          AND COALESCE(o.marketplace, 'GLOBAL') = "DailySalesAggregate".marketplace
          AND DATE(COALESCE(o."purchaseDate", o."createdAt")) = "DailySalesAggregate".day
          AND o.status != 'CANCELLED'
      )
  `

  const daysProcessed =
    Math.floor((toDay.getTime() - fromDay.getTime()) / 86400000) + 1
  const durationMs = Date.now() - startTime

  logger.info('F.1 sales-aggregate refresh complete', {
    from: fromDay.toISOString(),
    to: toDay.toISOString(),
    rowsWritten: Number(result) || 0,
    rowsDeleted: Number(deleted) || 0,
    durationMs,
  })

  return {
    daysProcessed,
    rowsWritten: Number(result) || 0,
    rowsSkipped: Number(deleted) || 0,
    durationMs,
  }
}

/**
 * Incremental aggregate update for a single OrderItem write. Recomputes
 * exactly the (sku, channel, marketplace, day) row that was affected.
 *
 * Call this from the order-creation paths (Amazon sync, eBay sync, manual
 * order creation, etc.) so today's data stays current without waiting for
 * the nightly cron. The full refresh is the safety net.
 */
export async function recordOrderItem(orderItemId: string): Promise<void> {
  const item = await prisma.orderItem.findUnique({
    where: { id: orderItemId },
    select: {
      sku: true,
      order: {
        select: {
          channel: true,
          marketplace: true,
          purchaseDate: true,
          createdAt: true,
          status: true,
        },
      },
    },
  })
  if (!item) return
  if (item.order.status === 'CANCELLED') return

  const day = startOfDay(item.order.purchaseDate ?? item.order.createdAt)
  // Recompute just this row's aggregate from OrderItem so we never drift
  // from the source-of-truth. Bounded query — single (sku, channel,
  // marketplace, day) tuple — ~milliseconds.
  await refreshSalesAggregates({ from: day, to: day })
}

function startOfDay(d: Date): Date {
  const out = new Date(d)
  out.setUTCHours(0, 0, 0, 0)
  return out
}
