#!/usr/bin/env node
// Today, ALL statuses, all marketplaces. Shows the gap between
// "Confirmed sales" (our current snapshot) vs "Gross sales" (Amazon's
// "Sales" tile which counts the original order amount even after
// refund / cancellation).

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

await q('1. Today (Europe/Rome) — every order regardless of status', `
  SELECT "channelOrderId", marketplace, status, "totalPrice"::numeric(10,2) AS total,
         "fulfillmentMethod"
  FROM "Order"
  WHERE channel='AMAZON' AND "deletedAt" IS NULL
    AND "purchaseDate" >= date_trunc('day', now() AT TIME ZONE 'Europe/Rome') AT TIME ZONE 'Europe/Rome'
  ORDER BY "purchaseDate";
`)

await q('2. Today — confirmed (OX.17 semantics) vs gross', `
  SELECT
    count(*) AS total_rows,
    SUM("totalPrice") FILTER (WHERE status NOT IN ('CANCELLED','REFUNDED','RETURNED'))::numeric(10,2) AS confirmed_eur,
    SUM("totalPrice") FILTER (WHERE status NOT IN ('CANCELLED'))::numeric(10,2) AS amazon_sales_excl_cancelled_eur,
    SUM("totalPrice")::numeric(10,2) AS gross_all_statuses_eur,
    SUM("totalPrice") FILTER (WHERE status IN ('CANCELLED'))::numeric(10,2) AS cancelled_eur,
    SUM("totalPrice") FILTER (WHERE status IN ('REFUNDED','RETURNED'))::numeric(10,2) AS refunded_returned_eur
  FROM "Order"
  WHERE channel='AMAZON' AND marketplace IN ('IT','DE','FR','ES','UK','NL','SE','PL','BE','IE','TR')
    AND "deletedAt" IS NULL
    AND "purchaseDate" >= date_trunc('day', now() AT TIME ZONE 'Europe/Rome') AT TIME ZONE 'Europe/Rome';
`)

await q('3. Yesterday — same comparison', `
  SELECT
    count(*) AS total_rows,
    SUM("totalPrice") FILTER (WHERE status NOT IN ('CANCELLED','REFUNDED','RETURNED'))::numeric(10,2) AS confirmed_eur,
    SUM("totalPrice") FILTER (WHERE status NOT IN ('CANCELLED'))::numeric(10,2) AS amazon_sales_excl_cancelled_eur,
    SUM("totalPrice")::numeric(10,2) AS gross_all_statuses_eur
  FROM "Order"
  WHERE channel='AMAZON' AND marketplace IN ('IT','DE','FR','ES','UK','NL','SE','PL','BE','IE','TR')
    AND "deletedAt" IS NULL
    AND "purchaseDate" >= date_trunc('day', now() AT TIME ZONE 'Europe/Rome') AT TIME ZONE 'Europe/Rome' - interval '1 day'
    AND "purchaseDate" <  date_trunc('day', now() AT TIME ZONE 'Europe/Rome') AT TIME ZONE 'Europe/Rome';
`)

await c.end()
