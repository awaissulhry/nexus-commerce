#!/usr/bin/env node
// Are we ingesting every Amazon marketplace the seller actually sells on?
// And is our "Sales" total semantically the same thing Amazon Seller
// Central's "Sales" tile shows?
//
// Reports:
//   1. Distinct marketplaces with orders in the last 90 days
//   2. Currency breakdown — anything other than EUR that gets dropped from
//      the headline (we sum only EUR for the tile total)
//   3. Recent IT orders with their totalPrice + item subtotals — does
//      totalPrice include shipping? VAT?

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

await q('1. Marketplaces with Amazon orders in last 90 days', `
  SELECT marketplace, count(*) AS orders,
         sum("totalPrice")::numeric(10,2) AS total_eur,
         min("purchaseDate") AS oldest, max("purchaseDate") AS newest
  FROM "Order"
  WHERE channel='AMAZON' AND "deletedAt" IS NULL
    AND "purchaseDate" > now() - interval '90 days'
  GROUP BY marketplace
  ORDER BY orders DESC;
`)

await q('2. Currency breakdown (non-EUR would be silently dropped from headline)', `
  SELECT "currencyCode", count(*) AS orders,
         sum("totalPrice")::numeric(10,2) AS total
  FROM "Order"
  WHERE channel='AMAZON' AND "deletedAt" IS NULL
    AND "purchaseDate" > now() - interval '90 days'
  GROUP BY "currencyCode"
  ORDER BY orders DESC;
`)

await q('3. ALL today/yesterday IT orders w/ totalPrice + item subtotals', `
  SELECT o."channelOrderId", o.status,
         o."totalPrice"::numeric(10,2) AS order_total,
         (SELECT sum(quantity*price)::numeric(10,2) FROM "OrderItem" WHERE "orderId"=o.id) AS items_subtotal,
         (o."totalPrice" - COALESCE((SELECT sum(quantity*price) FROM "OrderItem" WHERE "orderId"=o.id),0))::numeric(10,2) AS difference_shipping_or_tax,
         o."amazonMetadata"->'ShippingPrice'->>'Amount' AS shipping_amount,
         o."amazonMetadata"->'OrderTotal'->>'Amount' AS amz_order_total
  FROM "Order" o
  WHERE o.channel='AMAZON' AND o.marketplace='IT' AND o."deletedAt" IS NULL
    AND o."purchaseDate" > now() - interval '48 hours'
  ORDER BY o."purchaseDate" DESC;
`)

await q('4. Cross-channel orders (eBay, Shopify) in last 90d', `
  SELECT channel, "currencyCode", count(*) AS orders,
         sum("totalPrice")::numeric(10,2) AS total
  FROM "Order"
  WHERE "deletedAt" IS NULL
    AND "purchaseDate" > now() - interval '90 days'
  GROUP BY channel, "currencyCode"
  ORDER BY channel, orders DESC;
`)

await c.end()
