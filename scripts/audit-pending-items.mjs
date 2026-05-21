#!/usr/bin/env node
// Are OrderItem prices populated for PENDING orders?
// If yes, we can derive the order total from item quantity × price
// even when Amazon withholds OrderTotal from the order-level APIs.

import dotenv from 'dotenv'
import { fileURLToPath } from 'url'
import path from 'path'
import pg from 'pg'

const here = path.dirname(fileURLToPath(import.meta.url))
dotenv.config({ path: path.join(here, '..', '.env') })

const c = new pg.Client({ connectionString: process.env.DATABASE_URL })
await c.connect()

const r = await c.query(`
  SELECT
    o."channelOrderId",
    o.status,
    o."totalPrice"::numeric(10,2) AS order_total,
    o.marketplace,
    o."fulfillmentMethod",
    json_agg(json_build_object(
      'sku', oi.sku,
      'qty', oi.quantity,
      'price', oi.price::numeric(10,2)
    )) AS items,
    SUM(oi.quantity * oi.price)::numeric(10,2) AS items_total
  FROM "Order" o
  LEFT JOIN "OrderItem" oi ON oi."orderId" = o.id
  WHERE o.channel = 'AMAZON'
    AND o.status = 'PENDING'
    AND o."totalPrice" = 0
    AND o."deletedAt" IS NULL
  GROUP BY o.id, o."channelOrderId", o.status, o."totalPrice", o.marketplace, o."fulfillmentMethod"
  ORDER BY o."purchaseDate" DESC
  LIMIT 10
`)
console.table(r.rows)
await c.end()
