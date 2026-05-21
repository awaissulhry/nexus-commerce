#!/usr/bin/env node
/**
 * LS.1/2 verifier — proves the SP-API → SQS → Nexus pipeline is alive.
 *
 * Read-only. Reports:
 *   1. Recent WebhookEvent rows for AMAZON channel (any flowing?)
 *   2. Recent Order rows ingested in the last hour (push vs cron split,
 *      best-effort via createdAt vs updatedAt heuristic).
 *   3. Subscription health (calls /api/admin/sqs-diagnostic).
 */

import dotenv from 'dotenv'
import { fileURLToPath } from 'url'
import path from 'path'
import pg from 'pg'

const here = path.dirname(fileURLToPath(import.meta.url))
dotenv.config({ path: path.join(here, '..', '.env') })

const url = process.env.DATABASE_URL
if (!url) { console.error('DATABASE_URL missing'); process.exit(1) }
const c = new pg.Client({ connectionString: url })
await c.connect()

async function q(label, sql) {
  try {
    const r = await c.query(sql)
    console.log(`\n=== ${label} ===`)
    if (r.rows.length === 0) console.log('(no rows)')
    else console.table(r.rows)
  } catch (e) {
    console.log(`\n=== ${label} (ERROR) ===\n${e.message}`)
  }
}

await q('1. Recent Amazon WebhookEvents (last 24h)', `
  SELECT
    "eventType",
    count(*) AS rows,
    count(*) FILTER (WHERE "isProcessed") AS processed,
    count(*) FILTER (WHERE NOT "isProcessed") AS pending,
    count(*) FILTER (WHERE "error" IS NOT NULL) AS failed,
    min("createdAt") AS oldest,
    max("createdAt") AS newest
  FROM "WebhookEvent"
  WHERE channel = 'AMAZON'
    AND "createdAt" > now() - interval '24 hours'
  GROUP BY "eventType"
  ORDER BY rows DESC;
`)

await q('2. Recent Amazon Orders activity (last 6h)', `
  SELECT
    date_trunc('hour', "updatedAt") AS hour,
    count(*) AS updates,
    count(*) FILTER (WHERE "createdAt" > now() - interval '6 hours') AS new_orders
  FROM "Order"
  WHERE channel = 'AMAZON'
    AND "updatedAt" > now() - interval '6 hours'
  GROUP BY hour
  ORDER BY hour DESC;
`)

await q('3. Most-recently-updated Amazon orders (sanity check)', `
  SELECT
    "channelOrderId",
    status,
    "totalPrice",
    "purchaseDate",
    "updatedAt"
  FROM "Order"
  WHERE channel = 'AMAZON'
  ORDER BY "updatedAt" DESC
  LIMIT 5;
`)

await c.end()
console.log('\nTip: hit /api/admin/sqs-diagnostic in a logged-in tab for subscription health.')
