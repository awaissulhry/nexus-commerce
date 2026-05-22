#!/usr/bin/env node
// Where is the €882.55 gap between Amazon's T+1 report (DailySalesAggregate)
// and our Order table for yesterday?

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

// What markets are in DSA for yesterday?
await q('1. DailySalesAggregate for yesterday — per marketplace', `
  SELECT marketplace, channel, count(*) AS rows,
         sum("unitsSold") AS units,
         sum("grossRevenue")::numeric(10,2) AS gross
  FROM "DailySalesAggregate"
  WHERE channel='AMAZON'
    AND day >= date_trunc('day', now() AT TIME ZONE 'Europe/Rome') - interval '1 day'
    AND day <  date_trunc('day', now() AT TIME ZONE 'Europe/Rome')
  GROUP BY marketplace, channel
  ORDER BY gross DESC;
`)

// What markets are in our Order table for yesterday?
await q('2. Order table for yesterday — per marketplace', `
  SELECT marketplace, count(*) AS rows,
         sum("totalPrice")::numeric(10,2) AS gross
  FROM "Order"
  WHERE channel='AMAZON' AND "deletedAt" IS NULL
    AND "purchaseDate" >= date_trunc('day', now() AT TIME ZONE 'Europe/Rome') AT TIME ZONE 'Europe/Rome' - interval '1 day'
    AND "purchaseDate" <  date_trunc('day', now() AT TIME ZONE 'Europe/Rome') AT TIME ZONE 'Europe/Rome'
  GROUP BY marketplace
  ORDER BY gross DESC NULLS LAST;
`)

// What date does DSA actually cover? Check around yesterday.
await q('3. DSA date range with data — last 7 days', `
  SELECT day::date, channel, count(*) AS rows,
         sum("grossRevenue")::numeric(10,2) AS gross
  FROM "DailySalesAggregate"
  WHERE channel='AMAZON'
    AND day >= now() - interval '7 days'
  GROUP BY day, channel
  ORDER BY day DESC;
`)

// Same for Orders
await q('4. Order daily totals — last 7 days for comparison', `
  SELECT date_trunc('day', "purchaseDate" AT TIME ZONE 'Europe/Rome')::date AS day,
         count(*) AS orders,
         sum("totalPrice")::numeric(10,2) AS gross
  FROM "Order"
  WHERE channel='AMAZON' AND "deletedAt" IS NULL
    AND "purchaseDate" > now() - interval '7 days'
  GROUP BY day
  ORDER BY day DESC;
`)

// Compare day-by-day side by side
await q('5. DSA vs Orders side-by-side per day', `
  WITH d AS (
    SELECT day::date AS day, sum("grossRevenue")::numeric(10,2) AS dsa_gross
    FROM "DailySalesAggregate"
    WHERE channel='AMAZON' AND day >= now() - interval '7 days'
    GROUP BY day
  ),
  o AS (
    SELECT date_trunc('day', "purchaseDate" AT TIME ZONE 'Europe/Rome')::date AS day,
           sum("totalPrice")::numeric(10,2) AS orders_gross
    FROM "Order"
    WHERE channel='AMAZON' AND "deletedAt" IS NULL
      AND "purchaseDate" > now() - interval '7 days'
    GROUP BY day
  )
  SELECT COALESCE(d.day, o.day) AS day,
         d.dsa_gross,
         o.orders_gross,
         (COALESCE(d.dsa_gross,0) - COALESCE(o.orders_gross,0))::numeric(10,2) AS delta
  FROM d FULL OUTER JOIN o USING (day)
  ORDER BY day DESC;
`)

await c.end()
