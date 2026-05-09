#!/usr/bin/env node
/**
 * W1.2 — One-time backfill of DailySalesAggregate from existing
 * OrderItem history.
 *
 * The audit found DailySalesAggregate=0 in prod despite Orders
 * existing. W1.1 fixed the going-forward path (every new OrderItem
 * triggers recordOrderItem). This script catches up on historical
 * orders so the forecaster has inputs from day 1.
 *
 * Idempotent — uses ON CONFLICT DO UPDATE and only touches rows
 * sourced from ORDER_ITEM (preserves SP-API report-derived rows).
 *
 * Usage:
 *   node scripts/backfill-sales-aggregates.mjs              # default: last 365 days
 *   node scripts/backfill-sales-aggregates.mjs --days 30    # last 30 days
 *   node scripts/backfill-sales-aggregates.mjs --all        # earliest order → today
 */

import dotenv from 'dotenv'
import { fileURLToPath } from 'url'
import path from 'path'
import pg from 'pg'

const here = path.dirname(fileURLToPath(import.meta.url))
dotenv.config({ path: path.join(here, '..', '.env') })

let url = process.env.DATABASE_URL
if (!url) { console.error('DATABASE_URL missing'); process.exit(1) }
url = url.replace('-pooler', '')

const args = process.argv.slice(2)
const daysArg = args.includes('--days') ? Number(args[args.indexOf('--days') + 1]) : null
const all = args.includes('--all')

const c = new pg.Client({ connectionString: url })
await c.connect()

try {
  let from
  let to = new Date()
  to.setUTCHours(0, 0, 0, 0)

  if (all) {
    const r = await c.query(`SELECT MIN(COALESCE("purchaseDate", "createdAt")) AS min_day FROM "Order" WHERE status != 'CANCELLED'`)
    if (!r.rows[0].min_day) { console.log('No non-cancelled orders found.'); process.exit(0) }
    from = new Date(r.rows[0].min_day)
    from.setUTCHours(0, 0, 0, 0)
  } else {
    const days = Number.isFinite(daysArg) ? Math.max(1, Math.min(365, daysArg)) : 365
    from = new Date(to.getTime() - (days - 1) * 86400000)
  }

  console.log(`Backfill window: ${from.toISOString().slice(0,10)} → ${to.toISOString().slice(0,10)}`)

  const before = await c.query(`SELECT count(*)::int AS rows FROM "DailySalesAggregate"`)
  console.log(`DailySalesAggregate rows BEFORE: ${before.rows[0].rows}`)

  const start = Date.now()
  const inserted = await c.query(`
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
      SUM(oi.quantity)::int AS units_sold,
      SUM(oi.price * oi.quantity)::numeric(14,2) AS gross_revenue,
      COUNT(DISTINCT oi."orderId")::int AS orders_count,
      'ORDER_ITEM' AS source,
      NOW(), NOW()
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
    WHERE "DailySalesAggregate"."source" IN ('ORDER_ITEM')
  `, [from, to])

  const ms = Date.now() - start
  const after = await c.query(`SELECT count(*)::int AS rows, count(DISTINCT sku)::int AS skus, count(DISTINCT marketplace)::int AS marketplaces, MIN(day) AS oldest, MAX(day) AS newest, SUM("unitsSold")::int AS units, SUM("grossRevenue")::numeric(14,2) AS revenue FROM "DailySalesAggregate"`)
  console.log(`DailySalesAggregate rows AFTER:  ${after.rows[0].rows}  (${ms}ms)`)
  console.log(`Coverage: ${after.rows[0].skus} SKUs × ${after.rows[0].marketplaces} marketplaces, ${after.rows[0].oldest} → ${after.rows[0].newest}`)
  console.log(`Total: ${after.rows[0].units} units, €${after.rows[0].revenue} revenue`)
} finally {
  await c.end()
}
