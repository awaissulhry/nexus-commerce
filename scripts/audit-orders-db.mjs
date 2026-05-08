#!/usr/bin/env node
// Comprehensive /orders audit (read-only).
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

await run('1. Order counts by status', `
  SELECT count(*) AS total,
         count(*) FILTER (WHERE status = 'PENDING') AS pending,
         count(*) FILTER (WHERE status = 'PROCESSING') AS processing,
         count(*) FILTER (WHERE status = 'SHIPPED') AS shipped,
         count(*) FILTER (WHERE status = 'DELIVERED') AS delivered,
         count(*) FILTER (WHERE status = 'CANCELLED') AS cancelled,
         count(*) FILTER (WHERE status = 'REFUNDED') AS refunded,
         count(*) FILTER (WHERE status = 'ON_HOLD') AS on_hold,
         count(*) FILTER (WHERE status = 'PARTIALLY_SHIPPED') AS partially_shipped
  FROM "Order"
`)

await run('2. Recent activity windows', `
  SELECT
    count(*) FILTER (WHERE "createdAt" > NOW() - INTERVAL '7 days')  AS last_7d,
    count(*) FILTER (WHERE "createdAt" > NOW() - INTERVAL '30 days') AS last_30d,
    count(*) FILTER (WHERE "createdAt" > NOW() - INTERVAL '90 days') AS last_90d,
    count(*) FILTER (WHERE "createdAt" > NOW() - INTERVAL '365 days') AS last_365d
  FROM "Order"
`)

await run('3. Per-channel breakdown (90d)', `
  SELECT channel, marketplace,
         count(*) AS orders,
         count(*) FILTER (WHERE status NOT IN ('CANCELLED', 'REFUNDED')) AS active,
         SUM("totalAmount")::numeric(12,2) AS total_revenue,
         AVG("totalAmount")::numeric(12,2) AS avg_order_value
  FROM "Order"
  WHERE "createdAt" > NOW() - INTERVAL '90 days'
  GROUP BY channel, marketplace
  ORDER BY count(*) DESC
`)

await run('4. Fulfillment method breakdown', `
  SELECT "fulfillmentMethod", count(*) AS orders
  FROM "Order"
  WHERE "createdAt" > NOW() - INTERVAL '90 days'
  GROUP BY "fulfillmentMethod"
  ORDER BY count(*) DESC
`)

await run('5. Currency distribution (90d)', `
  SELECT currency, count(*) AS orders, SUM("totalAmount")::numeric(12,2) AS total
  FROM "Order"
  WHERE "createdAt" > NOW() - INTERVAL '90 days'
  GROUP BY currency
  ORDER BY count(*) DESC
`)

await run('6. Daily order velocity (30d)', `
  SELECT date_trunc('day', "createdAt")::date AS day,
         count(*) AS orders,
         SUM("totalAmount")::numeric(12,2) AS revenue
  FROM "Order"
  WHERE "createdAt" > NOW() - INTERVAL '30 days'
  GROUP BY day
  ORDER BY day DESC
  LIMIT 30
`)

await run('7. Late shipment risk (next 24h)', `
  SELECT count(*) AS at_risk_24h
  FROM "Order"
  WHERE status IN ('PENDING', 'PROCESSING')
    AND "shipByDate" IS NOT NULL
    AND "shipByDate" < NOW() + INTERVAL '24 hours'
`)

await run('8. Already-late shipments', `
  SELECT count(*) AS already_late
  FROM "Order"
  WHERE status IN ('PENDING', 'PROCESSING')
    AND "shipByDate" IS NOT NULL
    AND "shipByDate" < NOW()
`)

await run('9. OrderItem rollups (90d)', `
  SELECT count(*) AS total_lines,
         count(DISTINCT "orderId") AS orders_with_items,
         count(DISTINCT "productId") AS unique_products_sold,
         SUM(quantity) AS total_units_sold,
         AVG(quantity)::numeric(8,2) AS avg_units_per_line
  FROM "OrderItem" oi
  WHERE EXISTS (SELECT 1 FROM "Order" o WHERE o.id = oi."orderId" AND o."createdAt" > NOW() - INTERVAL '90 days')
`)

await run('10. Top 20 selling products (90d)', `
  SELECT p.name, p.sku,
         SUM(oi.quantity) AS units_sold,
         SUM(oi."totalPrice")::numeric(12,2) AS revenue
  FROM "OrderItem" oi
  JOIN "Order" o ON o.id = oi."orderId"
  JOIN "Product" p ON p.id = oi."productId"
  WHERE o."createdAt" > NOW() - INTERVAL '90 days'
  GROUP BY p.id, p.name, p.sku
  ORDER BY revenue DESC NULLS LAST
  LIMIT 20
`)

await run('11. Customer-related tables present?', `
  SELECT table_name FROM information_schema.tables
  WHERE table_schema = 'public'
    AND table_name IN ('Customer','CustomerAddress','CustomerNote','Refund','Return','Shipment','OrderActivity','OrderTag','OrderNote','OrderRiskScore')
  ORDER BY table_name
`)

await run('12. Refund table state (if exists)', `
  SELECT count(*) AS total_refunds,
         SUM(amount)::numeric(12,2) AS total_refunded
  FROM "Refund"
`)

await run('13. Order columns', `
  SELECT column_name, data_type, is_nullable
  FROM information_schema.columns
  WHERE table_name = 'Order'
  ORDER BY ordinal_position
`)

await run('14. OrderItem columns', `
  SELECT column_name, data_type, is_nullable
  FROM information_schema.columns
  WHERE table_name = 'OrderItem'
  ORDER BY ordinal_position
`)

await run('15. OrderStatus enum values', `
  SELECT enumlabel FROM pg_enum
  WHERE enumtypid = (SELECT oid FROM pg_type WHERE typname = 'OrderStatus')
  ORDER BY enumsortorder
`)

await run('16. Orders with shipments / returns', `
  SELECT
    (SELECT count(*) FROM "Order" o WHERE EXISTS (SELECT 1 FROM "Shipment" s WHERE s."orderId" = o.id)) AS orders_with_shipments,
    (SELECT count(*) FROM "Order" o WHERE EXISTS (SELECT 1 FROM "Return"   r WHERE r."orderId" = o.id)) AS orders_with_returns
`)

await run('17. Channel order ID idempotency', `
  SELECT channel, count(*) AS rows, count(DISTINCT "channelOrderId") AS unique_ids,
         count(*) - count(DISTINCT "channelOrderId") AS duplicate_count
  FROM "Order"
  WHERE "channelOrderId" IS NOT NULL
  GROUP BY channel
  ORDER BY duplicate_count DESC
`)

await run('18. Orders with NULL critical fields', `
  SELECT
    count(*) FILTER (WHERE "channelOrderId" IS NULL) AS null_channel_order_id,
    count(*) FILTER (WHERE "totalAmount" IS NULL)    AS null_total_amount,
    count(*) FILTER (WHERE currency IS NULL)         AS null_currency,
    count(*) FILTER (WHERE "shipByDate" IS NULL AND status IN ('PENDING','PROCESSING')) AS pending_no_ship_by,
    count(*) FILTER (WHERE "customerEmail" IS NULL)  AS null_customer_email
  FROM "Order"
`)

await run('19. Repeat-customer signal (by email, 365d)', `
  WITH x AS (
    SELECT lower("customerEmail") AS email, count(*) AS orders
    FROM "Order"
    WHERE "customerEmail" IS NOT NULL
      AND "createdAt" > NOW() - INTERVAL '365 days'
    GROUP BY lower("customerEmail")
  )
  SELECT count(*) AS unique_customers,
         count(*) FILTER (WHERE orders > 1) AS repeat_customers,
         AVG(orders)::numeric(8,2) AS avg_orders_per_customer
  FROM x
`)

await run('20. Order destination distribution (90d)', `
  SELECT "shippingCountry", count(*) AS orders
  FROM "Order"
  WHERE "createdAt" > NOW() - INTERVAL '90 days'
    AND "shippingCountry" IS NOT NULL
  GROUP BY "shippingCountry"
  ORDER BY count(*) DESC
  LIMIT 15
`)

await run('21. OrderActivity / audit trail rows', `
  SELECT count(*) AS rows FROM "OrderActivity"
`)

await run('22. Migration log: orders-related migrations', `
  SELECT migration_name, finished_at, rolled_back_at
  FROM _prisma_migrations
  WHERE migration_name ILIKE '%order%' OR migration_name ILIKE '%refund%' OR migration_name ILIKE '%customer%'
  ORDER BY finished_at DESC
  LIMIT 30
`)

await run('23. Index list on Order', `
  SELECT indexname, indexdef FROM pg_indexes
  WHERE tablename = 'Order'
  ORDER BY indexname
`)

await c.end()
console.log('\nAudit complete.')
