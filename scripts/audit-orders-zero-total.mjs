#!/usr/bin/env node
// OX.0 — flag orders whose totalPrice should NOT be zero.
//
// Amazon SP-API ListOrders withholds OrderTotal for PENDING orders, so
// PENDING + totalPrice=0 is expected. Anything else with totalPrice=0
// is a data accuracy issue — either:
//   - the order was ingested while PENDING and we haven't seen the
//     post-payment update yet (next 15-min cron should self-heal), or
//   - the order ages past our `since` cursor and is now permanently
//     stale at €0.00.
//
// Read-only. Reports counts + a sample of the worst offenders so an
// operator can decide whether to trigger a backfill window.

import dotenv from 'dotenv'
import { fileURLToPath } from 'url'
import path from 'path'
import pg from 'pg'

const here = path.dirname(fileURLToPath(import.meta.url))
dotenv.config({ path: path.join(here, '..', '.env') })

const url = process.env.DATABASE_URL
if (!url) {
  console.error('DATABASE_URL missing')
  process.exit(1)
}

const c = new pg.Client({ connectionString: url })
await c.connect()

async function run(label, sql) {
  try {
    const r = await c.query(sql)
    console.log(`\n=== ${label} ===`)
    if (r.rows.length === 0) console.log('(no rows)')
    else console.table(r.rows)
  } catch (e) {
    console.log(`\n=== ${label} (ERROR) ===\n${e.message}`)
  }
}

await run(
  '1. Zero-total breakdown by status (excluded by design: PENDING + CANCELLED)',
  `
    SELECT status,
           count(*) AS rows,
           min("purchaseDate") AS oldest,
           max("purchaseDate") AS newest
      FROM "Order"
     WHERE "totalPrice" = 0
       AND "deletedAt" IS NULL
     GROUP BY status
     ORDER BY rows DESC;
  `,
)

await run(
  '2. Stale zero-total orders (should self-heal but haven\'t)',
  `
    SELECT count(*) AS stale_count,
           count(*) FILTER (WHERE channel = 'AMAZON') AS amazon,
           count(*) FILTER (WHERE channel = 'EBAY') AS ebay,
           count(*) FILTER (WHERE channel = 'SHOPIFY') AS shopify,
           min("purchaseDate") AS oldest_stale,
           count(*) FILTER (WHERE "purchaseDate" < now() - interval '7 days') AS older_than_7d
      FROM "Order"
     WHERE "totalPrice" = 0
       AND status NOT IN ('PENDING', 'CANCELLED')
       AND "deletedAt" IS NULL;
  `,
)

await run(
  '3. Worst offenders sample (status, age, channel)',
  `
    SELECT id,
           channel,
           marketplace,
           "channelOrderId",
           status,
           "purchaseDate",
           "updatedAt"
      FROM "Order"
     WHERE "totalPrice" = 0
       AND status NOT IN ('PENDING', 'CANCELLED')
       AND "deletedAt" IS NULL
     ORDER BY "purchaseDate" ASC
     LIMIT 20;
  `,
)

await run(
  '4. PENDING-but-genuinely-old orders (likely abandoned)',
  `
    SELECT channel,
           marketplace,
           count(*) AS count,
           min("purchaseDate") AS oldest,
           max("purchaseDate") AS newest
      FROM "Order"
     WHERE status = 'PENDING'
       AND "totalPrice" = 0
       AND "purchaseDate" < now() - interval '7 days'
       AND "deletedAt" IS NULL
     GROUP BY channel, marketplace
     ORDER BY count DESC;
  `,
)

await c.end()
