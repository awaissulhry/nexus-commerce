#!/usr/bin/env node
// Quick /fulfillment/stock audit — answers "what stock movements are
// orphaned (no locationId) and which reasons / actors caused them".
// Read-only diagnostic; complements the deeper audit-stock-db.mjs.
import dotenv from 'dotenv'
import { fileURLToPath } from 'url'
import path from 'path'
import pg from 'pg'

const here = path.dirname(fileURLToPath(import.meta.url))
dotenv.config({ path: path.join(here, '..', '.env') })
const c = new pg.Client({ connectionString: process.env.DATABASE_URL })
await c.connect()

async function r(label, sql) {
  try {
    const x = await c.query(sql)
    console.log(`\n=== ${label} ===`)
    if (x.rows.length === 0) console.log('(no rows)')
    else console.table(x.rows)
  } catch(e) { console.log(`\n=== ${label} ERR: ${e.message} ===`) }
}

await r('Movements with NULL locationId — what reasons?', `
  SELECT reason::text, count(*)::int AS n,
    MIN("createdAt") AS oldest,
    MAX("createdAt") AS newest,
    string_agg(DISTINCT COALESCE(actor,'(null)'), ', ') AS actors
  FROM "StockMovement"
  WHERE "locationId" IS NULL
  GROUP BY reason
  ORDER BY count(*) DESC
`)

await r('Movement examples with NULL locationId (last 7d)', `
  SELECT id, reason::text, change, "warehouseId", actor, "referenceType", "createdAt"
  FROM "StockMovement"
  WHERE "locationId" IS NULL AND "createdAt" > now() - interval '7 days'
  ORDER BY "createdAt" DESC LIMIT 20
`)

await r('R.12 StockoutEvent table columns', `
  SELECT column_name FROM information_schema.columns
  WHERE table_name = 'StockoutEvent' ORDER BY ordinal_position
`)

await r('R.12 StockoutEvent counts (any open?)', `
  SELECT count(*)::int AS total
  FROM "StockoutEvent"
`)

await r('Channel listings detail', `
  SELECT cl.channel, cl.marketplace, cl."listingStatus", count(*)::int
  FROM "ChannelListing" cl GROUP BY cl.channel, cl.marketplace, cl."listingStatus"
  ORDER BY cl.channel, cl.marketplace
`)

await r('Buyables — sample with totalStock=0', `
  SELECT sku, name, "totalStock", "lowStockThreshold", "amazonAsin"
  FROM "Product"
  WHERE "isParent" = false AND "totalStock" = 0
  ORDER BY name LIMIT 10
`)

await r('Variant children stock distribution', `
  SELECT
    count(*) FILTER (WHERE "totalStock" = 0)::int AS zero,
    count(*) FILTER (WHERE "totalStock" > 0)::int AS positive,
    count(*)::int AS total
  FROM "Product"
  WHERE "isParent" = false AND "parentId" IS NOT NULL
`)

await r('Independent buyables (no parent) stock', `
  SELECT
    count(*) FILTER (WHERE "totalStock" = 0)::int AS zero,
    count(*) FILTER (WHERE "totalStock" > 0)::int AS positive,
    count(*)::int AS total
  FROM "Product"
  WHERE "isParent" = false AND "parentId" IS NULL
`)

await r('OutboundSyncQueue all syncTypes', `
  SELECT "syncType", "syncStatus"::text, count(*)::int
  FROM "OutboundSyncQueue"
  GROUP BY "syncType", "syncStatus" ORDER BY count(*) DESC
`)

await r('Active reservation TTL distribution', `
  SELECT reason,
    count(*) FILTER (WHERE "releasedAt" IS NULL AND "consumedAt" IS NULL)::int AS active,
    count(*)::int AS total
  FROM "StockReservation" GROUP BY reason
`)

await r('FBA cron last 24h cadence (every X minutes?)', `
  SELECT
    date_trunc('hour', "createdAt") AS hour,
    count(*)::int AS reconciliations
  FROM "StockMovement"
  WHERE reason = 'SYNC_RECONCILIATION' AND "createdAt" > now() - interval '24 hours'
  GROUP BY hour ORDER BY hour DESC LIMIT 30
`)

await r('Recent inbound applied (movements via InboundShipment)', `
  SELECT date_trunc('day', "createdAt")::date AS day,
    count(*)::int AS movements,
    SUM(change)::int AS units_in
  FROM "StockMovement"
  WHERE "referenceType" = 'InboundShipment' AND "createdAt" > now() - interval '60 days'
  GROUP BY day ORDER BY day DESC
`)

await c.end()
