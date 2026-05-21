#!/usr/bin/env node
// Read-only audit: for every populated table, compare createdAt (when we
// inserted the row) vs event-date columns (when the business event actually
// happened). "All on one day" symptom in UI usually means a query uses
// createdAt where it should use the event date.

import dotenv from 'dotenv'
import { fileURLToPath } from 'url'
import path from 'path'
import pg from 'pg'

const here = path.dirname(fileURLToPath(import.meta.url))
dotenv.config({ path: path.join(here, '..', '.env') })

const c = new pg.Client({ connectionString: process.env.DATABASE_URL })
await c.connect()

async function bucket(label, sql) {
  try {
    const r = await c.query(sql)
    console.log(`\n--- ${label} ---`)
    if (r.rows.length === 0) console.log('(empty)')
    else console.table(r.rows)
  } catch (e) {
    console.log(`\n--- ${label} ERROR ---`)
    console.log(' ', e.message)
  }
}

await bucket('Order — createdAt distribution', `
  SELECT to_char("createdAt", 'YYYY-MM-DD') AS day, count(*) AS rows
  FROM "Order" GROUP BY 1 ORDER BY 1 DESC LIMIT 5
`)

await bucket('Order — purchaseDate distribution (sample of last 5 days with data)', `
  SELECT to_char("purchaseDate", 'YYYY-MM-DD') AS day, count(*) AS rows
  FROM "Order" WHERE "purchaseDate" IS NOT NULL
  GROUP BY 1 ORDER BY 1 DESC LIMIT 5
`)

await bucket('OrderItem — createdAt distribution', `
  SELECT to_char("createdAt", 'YYYY-MM-DD') AS day, count(*) AS rows
  FROM "OrderItem" GROUP BY 1 ORDER BY 1 DESC LIMIT 5
`)

await bucket('FinancialTransaction — createdAt vs transactionDate', `
  SELECT
    to_char(min("createdAt"), 'YYYY-MM-DD') AS earliest_created,
    to_char(max("createdAt"), 'YYYY-MM-DD') AS latest_created,
    to_char(min("transactionDate"), 'YYYY-MM-DD') AS earliest_tx_date,
    to_char(max("transactionDate"), 'YYYY-MM-DD') AS latest_tx_date,
    count(*) AS total,
    count(*) FILTER (WHERE "createdAt"::date = NOW()::date) AS inserted_today,
    count(*) FILTER (WHERE "transactionDate"::date = NOW()::date) AS tx_date_today
  FROM "FinancialTransaction"
`)

await bucket('Return — createdAt distribution', `
  SELECT to_char("createdAt", 'YYYY-MM-DD') AS day, count(*) AS rows
  FROM "Return" GROUP BY 1 ORDER BY 1 DESC LIMIT 5
`)

await bucket('Return — has dedicated date columns?', `
  SELECT column_name, data_type
  FROM information_schema.columns
  WHERE table_name = 'Return' AND data_type LIKE '%timestamp%' OR (table_name='Return' AND data_type='date')
`)

await bucket('SettlementReport — startDate distribution', `
  SELECT to_char("startDate", 'YYYY-MM-DD') AS start_day, count(*) AS rows
  FROM "SettlementReport" GROUP BY 1 ORDER BY 1 DESC LIMIT 5
`)

await bucket('SettlementReport — createdAt vs startDate spread', `
  SELECT
    to_char(min("createdAt"), 'YYYY-MM-DD') AS earliest_created,
    to_char(max("createdAt"), 'YYYY-MM-DD') AS latest_created,
    to_char(min("startDate"), 'YYYY-MM-DD') AS earliest_window,
    to_char(max("endDate"), 'YYYY-MM-DD') AS latest_window
  FROM "SettlementReport"
`)

await bucket('DailySalesAggregate — date distribution (head/tail)', `
  (SELECT to_char(date, 'YYYY-MM-DD') AS day, count(*) AS rows, SUM(units)::int AS units, SUM(revenue)::numeric(10,2) AS revenue
   FROM "DailySalesAggregate" GROUP BY 1 ORDER BY 1 ASC LIMIT 3)
  UNION ALL
  (SELECT to_char(date, 'YYYY-MM-DD') AS day, count(*) AS rows, SUM(units)::int AS units, SUM(revenue)::numeric(10,2) AS revenue
   FROM "DailySalesAggregate" GROUP BY 1 ORDER BY 1 DESC LIMIT 3)
  ORDER BY day
`)

await bucket('APlusContent — createdAt distribution', `
  SELECT to_char("createdAt", 'YYYY-MM-DD') AS day, count(*) AS rows
  FROM "APlusContent" GROUP BY 1 ORDER BY 1 DESC LIMIT 5
`)

await bucket('APlusContent — does it have any source date column?', `
  SELECT column_name, data_type
  FROM information_schema.columns
  WHERE table_name = 'APlusContent' AND (data_type LIKE '%timestamp%' OR data_type='date')
`)

await bucket('Customer — firstOrderAt / lastOrderAt distribution', `
  SELECT
    count(*) AS total,
    count(*) FILTER (WHERE "firstOrderAt"::date = NOW()::date) AS first_order_today,
    count(*) FILTER (WHERE "lastOrderAt"::date = NOW()::date) AS last_order_today,
    to_char(min("firstOrderAt"), 'YYYY-MM-DD') AS earliest_first,
    to_char(max("lastOrderAt"), 'YYYY-MM-DD') AS latest_last
  FROM "Customer"
`)

// The smoking-gun query: of the top 5 dashboard tables, what fraction
// of rows have createdAt = today?
await bucket('SMOKING-GUN — what % of rows in each table were created today', `
  SELECT 'Order' AS table_name, count(*) AS total, count(*) FILTER (WHERE "createdAt"::date = NOW()::date) AS inserted_today, round(100.0 * count(*) FILTER (WHERE "createdAt"::date = NOW()::date) / NULLIF(count(*), 0), 1) AS pct_today FROM "Order"
  UNION ALL
  SELECT 'OrderItem', count(*), count(*) FILTER (WHERE "createdAt"::date = NOW()::date), round(100.0 * count(*) FILTER (WHERE "createdAt"::date = NOW()::date) / NULLIF(count(*), 0), 1) FROM "OrderItem"
  UNION ALL
  SELECT 'FinancialTransaction', count(*), count(*) FILTER (WHERE "createdAt"::date = NOW()::date), round(100.0 * count(*) FILTER (WHERE "createdAt"::date = NOW()::date) / NULLIF(count(*), 0), 1) FROM "FinancialTransaction"
  UNION ALL
  SELECT 'Return', count(*), count(*) FILTER (WHERE "createdAt"::date = NOW()::date), round(100.0 * count(*) FILTER (WHERE "createdAt"::date = NOW()::date) / NULLIF(count(*), 0), 1) FROM "Return"
  UNION ALL
  SELECT 'SettlementReport', count(*), count(*) FILTER (WHERE "createdAt"::date = NOW()::date), round(100.0 * count(*) FILTER (WHERE "createdAt"::date = NOW()::date) / NULLIF(count(*), 0), 1) FROM "SettlementReport"
  UNION ALL
  SELECT 'APlusContent', count(*), count(*) FILTER (WHERE "createdAt"::date = NOW()::date), round(100.0 * count(*) FILTER (WHERE "createdAt"::date = NOW()::date) / NULLIF(count(*), 0), 1) FROM "APlusContent"
`)

await c.end()
