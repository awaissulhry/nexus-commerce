#!/usr/bin/env node
// Comprehensive /fulfillment/stock audit (Phase 1C).
// Read-only.
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

await run('1. StockLocation counts', `
  SELECT count(*) AS total_locations,
    count(*) FILTER (WHERE "isActive" = true) AS active,
    count(*) FILTER (WHERE type = 'WAREHOUSE') AS warehouses,
    count(*) FILTER (WHERE type = 'AMAZON_FBA') AS fba,
    count(*) FILTER (WHERE type = 'CHANNEL_RESERVED') AS channel_reserved
  FROM "StockLocation"
`)

await run('2. Per-location detail', `
  SELECT id, code, name, type, "isActive",
    "warehouseId" IS NOT NULL AS warehouse_linked,
    array_length("servesMarketplaces", 1) AS marketplace_count
  FROM "StockLocation"
  ORDER BY type, code
`)

await run('3. StockLevel summary', `
  SELECT count(*) AS total_levels,
    count(DISTINCT "productId") AS products_with_stock,
    count(DISTINCT "locationId") AS locations_with_stock,
    SUM(quantity)::int AS total_units,
    SUM(reserved)::int AS total_reserved,
    SUM(available)::int AS total_available,
    count(*) FILTER (WHERE quantity = 0) AS zero_lines,
    count(*) FILTER (WHERE quantity < 0) AS negative_lines
  FROM "StockLevel"
`)

await run('4. Stock per location', `
  SELECT loc.code, loc.name, loc.type,
    count(DISTINCT slv."productId")::int AS unique_skus,
    SUM(slv.quantity)::int AS total_units,
    SUM(slv.reserved)::int AS total_reserved,
    SUM(slv.available)::int AS total_available,
    count(*) FILTER (WHERE slv.quantity = 0)::int AS zero_lines,
    count(*) FILTER (WHERE slv.quantity < 0)::int AS negative_lines,
    count(*) FILTER (WHERE slv."reorderThreshold" IS NOT NULL AND slv.quantity <= slv."reorderThreshold")::int AS at_reorder
  FROM "StockLocation" loc
  LEFT JOIN "StockLevel" slv ON slv."locationId" = loc.id
  GROUP BY loc.id, loc.code, loc.name, loc.type
  ORDER BY loc.type, loc.code
`)

await run('5. Reservation counts', `
  SELECT
    count(*) AS total,
    count(*) FILTER (WHERE "releasedAt" IS NULL AND "consumedAt" IS NULL) AS active,
    count(*) FILTER (WHERE "consumedAt" IS NOT NULL) AS consumed,
    count(*) FILTER (WHERE "releasedAt" IS NOT NULL) AS released,
    count(*) FILTER (WHERE "expiresAt" < now() AND "releasedAt" IS NULL AND "consumedAt" IS NULL) AS expired_unreleased,
    SUM(quantity) FILTER (WHERE "releasedAt" IS NULL AND "consumedAt" IS NULL)::int AS units_active
  FROM "StockReservation"
`)

await run('6. StockMovement last 30d by reason', `
  SELECT reason::text AS reason, count(*)::int AS n
  FROM "StockMovement"
  WHERE "createdAt" > now() - interval '30 days'
  GROUP BY reason
  ORDER BY count(*) DESC
`)

await run('7. StockMovement by referenceType (90d)', `
  SELECT COALESCE("referenceType", '(null)') AS ref, count(*)::int AS n
  FROM "StockMovement"
  WHERE "createdAt" > now() - interval '90 days'
  GROUP BY "referenceType"
  ORDER BY count(*) DESC
`)

await run('8. Movements with locationId NULL (legacy path use)', `
  SELECT
    count(*) AS total,
    count(*) FILTER (WHERE "createdAt" > now() - interval '30 days') AS last_30d,
    count(*) FILTER (WHERE "createdAt" > now() - interval '7 days') AS last_7d
  FROM "StockMovement"
  WHERE "locationId" IS NULL
`)

await run('9. totalStock cache drift vs SUM(StockLevel)', `
  SELECT
    count(*)::int AS products_with_drift,
    SUM(p."totalStock" - COALESCE(slv.sum_q, 0))::int AS total_drift_units
  FROM "Product" p
  LEFT JOIN (
    SELECT "productId", SUM(quantity) AS sum_q FROM "StockLevel" GROUP BY "productId"
  ) slv ON slv."productId" = p.id
  WHERE p."isParent" = false
    AND p."totalStock" != COALESCE(slv.sum_q, 0)
`)

await run('10. Drift breakdown (top 10)', `
  SELECT p.sku, p.name, p."totalStock" AS cached, COALESCE(slv.sum_q, 0)::int AS actual,
    (p."totalStock" - COALESCE(slv.sum_q, 0))::int AS delta
  FROM "Product" p
  LEFT JOIN (
    SELECT "productId", SUM(quantity) AS sum_q FROM "StockLevel" GROUP BY "productId"
  ) slv ON slv."productId" = p.id
  WHERE p."isParent" = false
    AND p."totalStock" != COALESCE(slv.sum_q, 0)
  ORDER BY abs(p."totalStock" - COALESCE(slv.sum_q, 0)) DESC
  LIMIT 10
`)

await run('11. CHECK constraint: available = quantity - reserved', `
  SELECT count(*)::int AS broken_rows
  FROM "StockLevel"
  WHERE available != (quantity - reserved)
`)

await run('12. Negative available (oversold signal)', `
  SELECT count(*)::int AS rows
  FROM "StockLevel" WHERE available < 0
`)

await run('13. Buyable products with zero stock', `
  SELECT count(*)::int AS zero_stock_buyables,
    count(*) FILTER (WHERE "isParent" = false AND status != 'INACTIVE')::int AS active_buyables
  FROM "Product"
  WHERE "isParent" = false AND "totalStock" = 0
`)

await run('14. Buyable products by stock health', `
  SELECT
    count(*) FILTER (WHERE "totalStock" = 0)::int AS stockouts,
    count(*) FILTER (WHERE "totalStock" > 0 AND "totalStock" <= 5)::int AS critical,
    count(*) FILTER (WHERE "totalStock" > 5 AND "totalStock" <= "lowStockThreshold")::int AS low,
    count(*) FILTER (WHERE "totalStock" > "lowStockThreshold")::int AS healthy,
    count(*)::int AS total_buyables
  FROM "Product" WHERE "isParent" = false
`)

await run('15. ChannelListing.stockBuffer usage', `
  SELECT
    count(*)::int AS total,
    count(*) FILTER (WHERE "stockBuffer" > 0)::int AS with_buffer,
    count(*) FILTER (WHERE "followMasterQuantity" = true)::int AS following_master,
    SUM("stockBuffer")::int AS sum_buffers
  FROM "ChannelListing"
`)

await run('16. ChannelListing masterQuantity drift vs Product.totalStock', `
  SELECT
    count(*)::int AS total_with_master,
    count(*) FILTER (WHERE cl."masterQuantity" != p."totalStock")::int AS drifted
  FROM "ChannelListing" cl
  JOIN "Product" p ON p.id = cl."productId"
  WHERE cl."masterQuantity" IS NOT NULL
`)

await run('17. OutboundSyncQueue (inventory-related)', `
  SELECT "syncStatus"::text AS status,
    "syncType",
    count(*)::int AS n
  FROM "OutboundSyncQueue"
  WHERE "syncType" = 'QUANTITY_UPDATE'
  GROUP BY "syncStatus", "syncType"
  ORDER BY count(*) DESC
`)

await run('18. Oldest pending QUANTITY_UPDATE', `
  SELECT min("createdAt") AS oldest_pending,
    EXTRACT(epoch FROM (now() - min("createdAt")))/60 AS oldest_minutes_old
  FROM "OutboundSyncQueue"
  WHERE "syncType" = 'QUANTITY_UPDATE' AND "syncStatus" = 'PENDING'
`)

await run('19. Last FBA sync reconciliation', `
  SELECT max("createdAt") AS last_at,
    EXTRACT(epoch FROM (now() - max("createdAt")))/60 AS minutes_ago,
    count(*) FILTER (WHERE "createdAt" > now() - interval '24 hours')::int AS last_24h
  FROM "StockMovement"
  WHERE reason = 'SYNC_RECONCILIATION'
`)

await run('20. CycleCount tables', `
  SELECT table_name FROM information_schema.tables
  WHERE table_schema='public' AND table_name LIKE 'CycleCount%'
  ORDER BY table_name
`)

await run('21. CycleCount counts', `
  SELECT count(*)::int AS total,
    count(*) FILTER (WHERE status = 'OPEN')::int AS open,
    count(*) FILTER (WHERE status = 'IN_PROGRESS')::int AS in_progress,
    count(*) FILTER (WHERE status = 'COMPLETED')::int AS completed,
    count(*) FILTER (WHERE status = 'CANCELLED')::int AS cancelled
  FROM "CycleCount"
`).catch(()=>{})

await run('22. Warehouse vs StockLocation', `
  SELECT
    (SELECT count(*) FROM "Warehouse")::int AS warehouses,
    (SELECT count(*) FROM "Warehouse" WHERE "isActive" = true)::int AS active_warehouses,
    (SELECT count(*) FROM "StockLocation" WHERE type = 'WAREHOUSE')::int AS sl_warehouses,
    (SELECT count(*) FROM "StockLocation" WHERE "warehouseId" IS NOT NULL)::int AS sl_linked
`)

await run('23. Schema columns: StockLocation', `
  SELECT column_name, data_type, is_nullable
  FROM information_schema.columns
  WHERE table_name = 'StockLocation'
  ORDER BY ordinal_position
`)

await run('24. Schema columns: StockLevel', `
  SELECT column_name, data_type, is_nullable
  FROM information_schema.columns
  WHERE table_name = 'StockLevel'
  ORDER BY ordinal_position
`)

await run('25. Schema columns: StockMovement', `
  SELECT column_name, data_type, is_nullable
  FROM information_schema.columns
  WHERE table_name = 'StockMovement'
  ORDER BY ordinal_position
`)

await run('26. Schema columns: StockReservation', `
  SELECT column_name, data_type, is_nullable
  FROM information_schema.columns
  WHERE table_name = 'StockReservation'
  ORDER BY ordinal_position
`)

await run('27. StockMovement indexes', `
  SELECT indexname FROM pg_indexes
  WHERE tablename = 'StockMovement' ORDER BY indexname
`)

await run('28. Recent movements - daily volume (30d)', `
  SELECT date_trunc('day', "createdAt")::date AS day, count(*)::int AS n
  FROM "StockMovement"
  WHERE "createdAt" > now() - interval '30 days'
  GROUP BY day ORDER BY day DESC LIMIT 14
`)

await run('29. StockoutEvent (R.12)', `
  SELECT
    count(*)::int AS total,
    count(*) FILTER (WHERE "resolvedAt" IS NULL)::int AS open,
    count(*) FILTER (WHERE "createdAt" > now() - interval '30 days')::int AS last_30d
  FROM "StockoutEvent"
`).catch(()=>{})

await run('30. Products buyable count by parent linkage', `
  SELECT
    count(*) FILTER (WHERE "isParent" = false)::int AS buyables,
    count(*) FILTER (WHERE "isParent" = true)::int AS parents,
    count(*) FILTER (WHERE "isParent" = false AND "parentId" IS NOT NULL)::int AS variant_children
  FROM "Product"
`)

await run('31. Movements actor breakdown 30d', `
  SELECT COALESCE(actor, '(null)') AS actor, count(*)::int AS n
  FROM "StockMovement"
  WHERE "createdAt" > now() - interval '30 days'
  GROUP BY actor ORDER BY count(*) DESC LIMIT 20
`)

await c.end()
console.log('\n[audit complete]')
