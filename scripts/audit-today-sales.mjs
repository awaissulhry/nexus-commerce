#!/usr/bin/env node
// One-shot probe — what does our DB say about today's Italian Amazon
// orders + their totals, vs what Amazon Seller Central shows?

import dotenv from 'dotenv'
import { fileURLToPath } from 'url'
import path from 'path'
import pg from 'pg'

const here = path.dirname(fileURLToPath(import.meta.url))
dotenv.config({ path: path.join(here, '..', '.env') })

const c = new pg.Client({ connectionString: process.env.DATABASE_URL })
await c.connect()

async function q(label, sql) {
  const r = await c.query(sql)
  console.log(`\n=== ${label} ===`)
  if (r.rows.length === 0) console.log('(no rows)')
  else console.table(r.rows)
}

// Italian business day start (Europe/Rome) — server-side date_trunc.
await q('1. Orders placed TODAY (Europe/Rome) — Italian marketplace', `
  SELECT
    "channelOrderId",
    status,
    "totalPrice",
    "currencyCode",
    "purchaseDate",
    "marketplace",
    "fulfillmentMethod"
  FROM "Order"
  WHERE channel = 'AMAZON'
    AND marketplace = 'IT'
    AND "deletedAt" IS NULL
    AND "purchaseDate" >= date_trunc('day', now() AT TIME ZONE 'Europe/Rome') AT TIME ZONE 'Europe/Rome'
  ORDER BY "purchaseDate" DESC;
`)

await q('2. Sales sum TODAY (Europe/Rome) — matches Global Snapshot logic', `
  SELECT
    count(*) AS order_count,
    sum("totalPrice")::numeric(10,2) AS gross_excl_cancelled,
    sum("totalPrice") FILTER (WHERE status NOT IN ('CANCELLED','REFUNDED','RETURNED'))::numeric(10,2) AS gross_per_ox17,
    count(*) FILTER (WHERE "totalPrice" = 0) AS zero_priced_rows
  FROM "Order"
  WHERE channel = 'AMAZON'
    AND marketplace = 'IT'
    AND "deletedAt" IS NULL
    AND "currencyCode" = 'EUR'
    AND "purchaseDate" >= date_trunc('day', now() AT TIME ZONE 'Europe/Rome') AT TIME ZONE 'Europe/Rome';
`)

await q('3. Yesterday — sanity-check the day boundary works', `
  SELECT
    date_trunc('day', "purchaseDate" AT TIME ZONE 'Europe/Rome')::date AS local_day,
    count(*) AS order_count,
    sum("totalPrice")::numeric(10,2) AS gross
  FROM "Order"
  WHERE channel = 'AMAZON'
    AND marketplace = 'IT'
    AND "deletedAt" IS NULL
    AND "purchaseDate" >= date_trunc('day', now() AT TIME ZONE 'Europe/Rome') AT TIME ZONE 'Europe/Rome' - interval '2 days'
  GROUP BY local_day
  ORDER BY local_day DESC;
`)

await c.end()
