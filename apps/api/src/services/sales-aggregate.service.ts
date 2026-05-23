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
  // DA-RT.2 — TZ-aware day boundaries. See startOfRomeDay note below.
  const fromDay = startOfRomeDay(args.from)
  const toDay = startOfRomeDay(args.to)

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

  // DA-RT.2 — two corrections vs the original AR.1 SQL:
  //
  // 1. TZ-aware day bucketing. `DATE(timestamptz)` uses UTC, which
  //    shifts the calendar day by 1–2 hours every day for Europe/Rome
  //    (CET = UTC+1, CEST = UTC+2). Orders placed late-evening local
  //    bucket into the NEXT day in UTC. Switch to
  //    `date_trunc('day', ... AT TIME ZONE 'Europe/Rome')::date` so
  //    the aggregate's calendar matches operator + Amazon Seller
  //    Central + the dashboard global-snapshot.
  //
  // 2. Order.totalPrice apportionment. The original SQL summed
  //    `oi.price * oi.quantity` — which returns 0 for the long-tail
  //    SHIPPED+€0 orders (Amazon-withheld OrderTotal, no OrderItem
  //    price either). New CTE first establishes per-order quantity
  //    total, then per item:
  //      - oi.price > 0          → use oi.price * oi.quantity
  //      - else o.totalPrice > 0 → apportion totalPrice by qty share
  //      - else                  → 0 (no estimate at this layer;
  //                                runtime callers can layer the
  //                                ChannelListing estimate on top via
  //                                the central computeOrderRevenue
  //                                helper from DA-RT.1)
  //
  // The CTE keeps the single-roundtrip INSERT...SELECT shape so the
  // wallclock cost stays minimal even at scale.
  const result = await prisma.$executeRawUnsafe(
    `
    WITH "items_with_share" AS (
      SELECT
        oi.sku,
        oi.quantity,
        oi.price,
        o.id AS order_id,
        o.channel::text AS channel,
        COALESCE(o.marketplace, 'GLOBAL') AS marketplace,
        o."totalPrice" AS order_total,
        SUM(oi.quantity) OVER (PARTITION BY o.id) AS order_qty_total,
        date_trunc(
          'day',
          COALESCE(o."purchaseDate", o."createdAt") AT TIME ZONE 'Europe/Rome'
        )::date AS day
      FROM "OrderItem" oi
      JOIN "Order" o ON o.id = oi."orderId"
      WHERE date_trunc(
              'day',
              COALESCE(o."purchaseDate", o."createdAt") AT TIME ZONE 'Europe/Rome'
            )::date >= $1::date
        AND date_trunc(
              'day',
              COALESCE(o."purchaseDate", o."createdAt") AT TIME ZONE 'Europe/Rome'
            )::date <= $2::date
        AND o.status != 'CANCELLED'
    )
    INSERT INTO "DailySalesAggregate" (
      id, sku, channel, marketplace, day,
      "unitsSold", "grossRevenue", "ordersCount", source,
      "createdAt", "updatedAt"
    )
    SELECT
      gen_random_uuid()::text AS id,
      sku,
      channel,
      marketplace,
      day,
      SUM(quantity)::int AS "unitsSold",
      SUM(
        CASE
          WHEN price IS NOT NULL AND price > 0
            THEN price * quantity
          WHEN order_total IS NOT NULL AND order_total > 0 AND order_qty_total > 0
            THEN order_total * (quantity::numeric / order_qty_total)
          ELSE 0
        END
      )::numeric(14,2) AS "grossRevenue",
      COUNT(DISTINCT order_id)::int AS "ordersCount",
      'ORDER_ITEM' AS source,
      NOW() AS "createdAt",
      NOW() AS "updatedAt"
    FROM "items_with_share"
    GROUP BY sku, channel, marketplace, day
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
  //
  // DA-RT.2 — `DATE(...)` → `date_trunc('day', ... AT TZ 'Europe/Rome')
  // ::date` here too, otherwise the NOT EXISTS check uses UTC day
  // and stale aggregates from yesterday-UTC-but-today-Rome don't get
  // deleted when their underlying orders were cancelled.
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
          AND date_trunc(
                'day',
                COALESCE(o."purchaseDate", o."createdAt") AT TIME ZONE 'Europe/Rome'
              )::date = "DailySalesAggregate".day
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

  // DA-RT.2 — match the SQL's TZ-aware day bucketing. startOfDay
  // was setting UTCHours to 0 — the UTC calendar day. But the refresh
  // SQL groups by Europe/Rome calendar day. A late-evening Rome order
  // (e.g. 23:00 local = 21:00 UTC during CEST) sat at UTC-day N while
  // SQL bucketed it under Rome-day N+1; the scan window [N..N] missed
  // it. Now both sides use the local calendar day so the bounded
  // single-row update lands on the right partition.
  const day = startOfRomeDay(item.order.purchaseDate ?? item.order.createdAt)
  // Recompute just this row's aggregate from OrderItem so we never drift
  // from the source-of-truth. Bounded query — single (sku, channel,
  // marketplace, day) tuple — ~milliseconds.
  await refreshSalesAggregates({ from: day, to: day })
}

/**
 * UTC midnight of the calendar day in Europe/Rome that contains `d`.
 * Used to align JS-side day boundaries with the SQL's
 * `date_trunc('day', ... AT TIME ZONE 'Europe/Rome')::date` bucket.
 *
 * Example: 2026-05-23T23:00:00Z (= 2026-05-24 01:00 in Rome under
 * CEST) → returns 2026-05-24T00:00:00Z.
 */
function startOfRomeDay(d: Date): Date {
  const ymd = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Rome',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(d)
  // Parse "YYYY-MM-DD" as UTC midnight so Postgres ::date coerces it
  // back to the same calendar date without further TZ math.
  return new Date(`${ymd}T00:00:00Z`)
}
