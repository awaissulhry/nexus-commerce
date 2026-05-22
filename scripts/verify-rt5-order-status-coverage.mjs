#!/usr/bin/env node
/**
 * RT.5 verifier — compares ORDER_CHANGE vs ORDER_STATUS_CHANGE coverage
 * during the 7-day parallel-run window.
 *
 * The goal: prove that everything ORDER_CHANGE sees, ORDER_STATUS_CHANGE
 * also sees (or surfaces the deltas so we can investigate). Once 7d of
 * data confirms equivalence we'll ship a follow-up phase that removes
 * the legacy ORDER_CHANGE subscription.
 *
 * Reports:
 *   1. Subscription state (both types active?)
 *   2. WebhookEvent counts per type over the configurable window
 *   3. Per-AmazonOrderId coverage: did both types fire on the same
 *      order, or only one?
 *   4. Average events-per-order ratio — should be ~1:1 once both
 *      subscriptions have been live for the full window.
 *
 * Usage: node scripts/verify-rt5-order-status-coverage.mjs [--days N]
 */

import dotenv from 'dotenv'
import { fileURLToPath } from 'url'
import path from 'path'
import pg from 'pg'

const here = path.dirname(fileURLToPath(import.meta.url))
dotenv.config({ path: path.join(here, '..', '.env') })

const daysFlag = process.argv.indexOf('--days')
const days = daysFlag > -1 ? Number(process.argv[daysFlag + 1] ?? '7') : 7

const url = process.env.DATABASE_URL
if (!url) { console.error('DATABASE_URL missing'); process.exit(1) }
const c = new pg.Client({ connectionString: url })
await c.connect()

console.log(`\n=== Window: last ${days} days ===\n`)

console.log('=== 1. WebhookEvent counts per notification type ===')
const counts = await c.query(`
  SELECT
    "eventType",
    count(*) AS total,
    count(*) FILTER (WHERE "isProcessed") AS processed,
    count(*) FILTER (WHERE "error" IS NOT NULL) AS failed,
    min("createdAt") AS earliest,
    max("createdAt") AS latest
  FROM "WebhookEvent"
  WHERE channel = 'AMAZON'
    AND "createdAt" > now() - ($1 || ' days')::interval
    AND "eventType" IN ('ORDER_CHANGE', 'ORDER_STATUS_CHANGE')
  GROUP BY "eventType"
  ORDER BY "eventType";
`, [days])
console.table(counts.rows)

if (counts.rows.length < 2) {
  console.log(
    '\nOnly one subscription producing events yet. Wait for the next push window — both must be live for the verifier to compare coverage.',
  )
  await c.end()
  process.exit(0)
}

console.log('\n=== 2. Per-order coverage (did both types fire?) ===')
const perOrder = await c.query(`
  WITH events AS (
    SELECT
      "eventType",
      COALESCE(
        (payload->'Payload'->'OrderChangeNotification'->>'AmazonOrderId'),
        (payload->'Payload'->'OrderStatusChangeNotification'->>'AmazonOrderId')
      ) AS amazon_order_id
    FROM "WebhookEvent"
    WHERE channel = 'AMAZON'
      AND "createdAt" > now() - ($1 || ' days')::interval
      AND "eventType" IN ('ORDER_CHANGE', 'ORDER_STATUS_CHANGE')
  )
  SELECT
    bool_or("eventType" = 'ORDER_CHANGE')        AS has_order_change,
    bool_or("eventType" = 'ORDER_STATUS_CHANGE') AS has_status_change,
    count(*) AS orders
  FROM events
  WHERE amazon_order_id IS NOT NULL
  GROUP BY amazon_order_id
`, [days])

const bothCount = perOrder.rows.filter((r) => r.has_order_change && r.has_status_change).length
const onlyOrderChange = perOrder.rows.filter((r) => r.has_order_change && !r.has_status_change).length
const onlyStatusChange = perOrder.rows.filter((r) => !r.has_order_change && r.has_status_change).length
console.log({
  orders_with_both:               bothCount,
  orders_with_only_ORDER_CHANGE:  onlyOrderChange,
  orders_with_only_STATUS_CHANGE: onlyStatusChange,
  total_unique_orders:            perOrder.rows.length,
})

if (onlyOrderChange > 0) {
  console.log(
    `\n⚠️  ${onlyOrderChange} order(s) seen by ORDER_CHANGE but NOT ORDER_STATUS_CHANGE — cutover would lose coverage. Investigate before removing the legacy subscription.`,
  )
}
if (onlyStatusChange > 0) {
  console.log(
    `\nℹ️  ${onlyStatusChange} order(s) seen only by ORDER_STATUS_CHANGE — expected during the early ramp window; revisit after 7d.`,
  )
}
if (bothCount === perOrder.rows.length && perOrder.rows.length > 0) {
  console.log('\n✅ 100% coverage parity. Safe to cut over once the full 7-day window passes.')
}

console.log('\n=== 3. Subscription state (live SP-API check) ===')
console.log(
  'Hit GET /api/admin/amazon-notification-status from a logged-in tab — `subscriptions.ORDER_CHANGE` and `subscriptions.ORDER_STATUS_CHANGE` should both have a `subscriptionId`.',
)

await c.end()
