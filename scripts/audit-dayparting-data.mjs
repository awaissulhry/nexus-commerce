#!/usr/bin/env node
// Read-only audit: what data can power a product/market/channel/hourly dayparting rebuild?
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

// ── Amazon ad hourly stream (gated on AMS) ──
await run('1. AmazonAdsHourlyPerformance — volume + span', `
  SELECT count(*) AS rows,
         count(DISTINCT marketplace) AS markets,
         count(DISTINCT "adProduct") AS ad_products,
         count(DISTINCT "entityType") AS entity_types,
         count(DISTINCT "localEntityId") AS local_entities,
         min(date) AS first_date, max(date) AS last_date
  FROM "AmazonAdsHourlyPerformance"
`)
await run('2. AmazonAdsHourlyPerformance — by marketplace × adProduct', `
  SELECT marketplace, "adProduct", "entityType", count(*) AS rows,
         sum(impressions) AS impressions, sum(clicks) AS clicks
  FROM "AmazonAdsHourlyPerformance"
  GROUP BY 1,2,3 ORDER BY rows DESC LIMIT 20
`)

// ── Orders as a universal hourly demand signal ──
await run('3. Order — by channel, purchaseDate coverage + span', `
  SELECT channel,
         count(*) AS orders,
         count(*) FILTER (WHERE "purchaseDate" IS NOT NULL) AS with_purchase_date,
         count(DISTINCT marketplace) AS markets,
         min("purchaseDate") AS first, max("purchaseDate") AS last
  FROM "Order"
  WHERE "deletedAt" IS NULL
  GROUP BY 1 ORDER BY orders DESC
`)
await run('4. Order — last 90d, by channel × marketplace', `
  SELECT channel, marketplace, count(*) AS orders
  FROM "Order"
  WHERE "deletedAt" IS NULL AND "purchaseDate" >= now() - interval '90 days'
  GROUP BY 1,2 ORDER BY orders DESC LIMIT 25
`)
await run('5. OrderItem — product/SKU linkage', `
  SELECT count(*) AS items,
         count(*) FILTER (WHERE sku IS NOT NULL) AS with_sku,
         count(*) FILTER (WHERE "productId" IS NOT NULL) AS with_product,
         count(DISTINCT sku) AS distinct_skus,
         count(DISTINCT "productId") AS distinct_products
  FROM "OrderItem"
`)
// hourly shape sanity-check (Rome local hour). Proves the per-hour signal is real.
await run('6. Sales by Rome-local hour (last 90d, all channels)', `
  SELECT extract(hour FROM ("purchaseDate" AT TIME ZONE 'UTC' AT TIME ZONE 'Europe/Rome'))::int AS rome_hour,
         count(*) AS orders
  FROM "Order"
  WHERE "deletedAt" IS NULL AND "purchaseDate" >= now() - interval '90 days'
  GROUP BY 1 ORDER BY 1
`)
await run('7. OrderItem schema sanity — columns present', `
  SELECT column_name, data_type
  FROM information_schema.columns
  WHERE table_name = 'OrderItem'
    AND column_name IN ('sku','productId','quantity','unitPriceCents','totalCents','priceCents','itemPriceCents','currencyCode')
  ORDER BY column_name
`)

await c.end()
console.log('\nDone.')
