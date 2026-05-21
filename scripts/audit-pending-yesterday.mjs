#!/usr/bin/env node
// What's the current state of yesterday's orders + can we estimate
// the pending one from ChannelListing?

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

// All May 21 (yesterday in Europe/Rome) Italian orders
await q('1. Yesterday IT orders — current state', `
  SELECT
    "channelOrderId", status, "totalPrice"::numeric(10,2) AS price,
    "purchaseDate", marketplace, "fulfillmentMethod"
  FROM "Order"
  WHERE channel='AMAZON' AND marketplace='IT' AND "deletedAt" IS NULL
    AND "purchaseDate" >= '2026-05-20T22:00:00Z'
    AND "purchaseDate" <  '2026-05-21T22:00:00Z'
  ORDER BY "purchaseDate";
`)

// Specifically the pending one
await q('2. Order 171-3501792-1481143 — status + items + listing lookup', `
  SELECT
    o."channelOrderId", o.status, o."totalPrice"::numeric(10,2) AS order_total,
    oi.sku, oi.quantity, oi.price::numeric(10,2) AS item_price,
    p.id AS product_id, p."basePrice"::numeric(10,2) AS base_price,
    cl.price::numeric(10,2) AS listing_price,
    cl."salePrice"::numeric(10,2) AS listing_sale_price,
    cl.marketplace AS listing_market
  FROM "Order" o
  LEFT JOIN "OrderItem" oi ON oi."orderId" = o.id
  LEFT JOIN "Product" p ON p.id = oi."productId"
  LEFT JOIN "ChannelListing" cl ON cl."productId" = p.id
       AND cl.channel = 'AMAZON' AND cl.marketplace = o.marketplace
  WHERE o."channelOrderId" = '171-3501792-1481143';
`)

// Sum what SR.1 would compute for yesterday
await q('3. SR.1 expected estimate for yesterday IT', `
  SELECT
    o."channelOrderId",
    SUM(oi.quantity * COALESCE(cl."salePrice", cl.price, p."basePrice", 0))::numeric(10,2) AS estimated_total
  FROM "Order" o
  JOIN "OrderItem" oi ON oi."orderId" = o.id
  LEFT JOIN "Product" p ON p.id = oi."productId"
  LEFT JOIN "ChannelListing" cl ON cl."productId" = p.id
       AND cl.channel = 'AMAZON' AND cl.marketplace = o.marketplace
  WHERE o.channel = 'AMAZON' AND o.status = 'PENDING' AND o."totalPrice" = 0
    AND o."deletedAt" IS NULL AND o.marketplace = 'IT'
    AND o."purchaseDate" >= '2026-05-20T22:00:00Z'
    AND o."purchaseDate" <  '2026-05-21T22:00:00Z'
  GROUP BY o."channelOrderId";
`)

await c.end()
