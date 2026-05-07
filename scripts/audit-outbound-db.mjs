#!/usr/bin/env node
// One-shot read-only audit queries for /fulfillment/outbound rebuild.
// Run from repo root: node scripts/audit-outbound-db.mjs
import dotenv from 'dotenv'
import { fileURLToPath } from 'url'
import path from 'path'
import pg from 'pg'

const here = path.dirname(fileURLToPath(import.meta.url))
dotenv.config({ path: path.join(here, '..', '.env') })
dotenv.config({ path: path.join(here, '..', 'packages', 'database', '.env') })

const url = process.env.DATABASE_URL
if (!url) { console.error('DATABASE_URL missing'); process.exit(1) }

const client = new pg.Client({ connectionString: url })
await client.connect()

async function run(label, sql) {
  try {
    const r = await client.query(sql)
    console.log(`\n=== ${label} ===`)
    console.table(r.rows)
  } catch (e) {
    console.log(`\n=== ${label} (ERROR) ===`)
    console.log(e.message)
  }
}

await run('Tables present (outbound surface)', `
  SELECT table_name FROM information_schema.tables
  WHERE table_schema='public'
  AND table_name IN ('Order','OrderItem','Shipment','ShipmentItem','Carrier','OrderRoutingRule','Return','ReviewRequest','OrderTag','Warehouse')
  ORDER BY table_name;
`)

await run('Order count totals (90d window)', `
  SELECT
    count(*)::int as total_orders,
    count(*) FILTER (WHERE status = 'PENDING')::int as pending,
    count(*) FILTER (WHERE status = 'PROCESSING')::int as processing,
    count(*) FILTER (WHERE status = 'SHIPPED')::int as shipped,
    count(*) FILTER (WHERE status = 'DELIVERED')::int as delivered,
    count(*) FILTER (WHERE status = 'CANCELLED')::int as cancelled
  FROM "Order"
  WHERE "createdAt" > NOW() - INTERVAL '90 days';
`)

await run('Order all-time totals', `
  SELECT
    count(*)::int as total_orders,
    count(*) FILTER (WHERE "shippedAt" IS NOT NULL)::int as ever_shipped,
    count(*) FILTER (WHERE "deliveredAt" IS NOT NULL)::int as ever_delivered,
    count(*) FILTER (WHERE "cancelledAt" IS NOT NULL)::int as ever_cancelled,
    min("createdAt") as oldest,
    max("createdAt") as newest
  FROM "Order";
`)

await run('Orders by channel × fulfillment method (30d)', `
  SELECT
    channel::text as channel,
    coalesce(marketplace, 'NULL') as marketplace,
    coalesce("fulfillmentMethod", 'NULL') as fulfillment,
    count(*)::int as orders,
    count(*) FILTER (WHERE "shippedAt" IS NULL AND status NOT IN ('CANCELLED','DELIVERED'))::int as needs_action
  FROM "Order"
  WHERE "createdAt" > NOW() - INTERVAL '30 days'
  GROUP BY channel, marketplace, "fulfillmentMethod"
  ORDER BY orders DESC;
`)

await run('Orders by channel — all time', `
  SELECT
    channel::text,
    count(*)::int as orders
  FROM "Order"
  GROUP BY channel
  ORDER BY orders DESC;
`)

await run('Order columns relevant to outbound', `
  SELECT column_name, data_type
  FROM information_schema.columns
  WHERE table_name = 'Order'
    AND (column_name ILIKE '%ship%'
      OR column_name ILIKE '%track%'
      OR column_name ILIKE '%carrier%'
      OR column_name ILIKE '%fulfill%'
      OR column_name ILIKE '%deliver%'
      OR column_name ILIKE '%cancel%'
      OR column_name ILIKE '%packed%'
      OR column_name ILIKE '%picked%')
  ORDER BY ordinal_position;
`)

await run('Shipment row counts by status', `
  SELECT
    status::text,
    count(*)::int as shipments,
    count(*) FILTER (WHERE "labelUrl" IS NOT NULL)::int as has_label,
    count(*) FILTER (WHERE "trackingNumber" IS NOT NULL)::int as has_tracking,
    count(*) FILTER (WHERE "trackingPushedAt" IS NOT NULL)::int as tracking_pushed,
    count(*) FILTER (WHERE "trackingPushError" IS NOT NULL)::int as tracking_push_errored
  FROM "Shipment"
  GROUP BY status
  ORDER BY shipments DESC;
`)

await run('Shipment by carrier', `
  SELECT
    "carrierCode"::text as carrier,
    count(*)::int as shipments,
    count(*) FILTER (WHERE status = 'DELIVERED')::int as delivered,
    coalesce(round(avg("costCents"))::int, 0) as avg_cost_cents,
    coalesce(sum("costCents"), 0)::bigint as total_cost_cents
  FROM "Shipment"
  GROUP BY "carrierCode"
  ORDER BY shipments DESC;
`)

await run('Shipments per order — multi-package detection', `
  SELECT shipments_per_order, count(*)::int as orders
  FROM (
    SELECT "orderId", count(*) as shipments_per_order
    FROM "Shipment"
    WHERE "orderId" IS NOT NULL
    GROUP BY "orderId"
  ) s
  GROUP BY shipments_per_order
  ORDER BY shipments_per_order;
`)

await run('Carrier configurations', `
  SELECT code::text, name, "isActive",
    ("credentialsEncrypted" IS NOT NULL) as has_credentials,
    "createdAt", "updatedAt"
  FROM "Carrier"
  ORDER BY code;
`)

await run('Late shipment risk (PENDING orders past ship-by horizon — derived)', `
  SELECT
    count(*) FILTER (WHERE "purchaseDate" < NOW() - INTERVAL '24 hours')::int as past_24h_no_ship,
    count(*) FILTER (WHERE "purchaseDate" < NOW() - INTERVAL '48 hours')::int as past_48h_no_ship,
    count(*) FILTER (WHERE "purchaseDate" < NOW() - INTERVAL '72 hours')::int as past_72h_no_ship
  FROM "Order"
  WHERE status NOT IN ('SHIPPED','DELIVERED','CANCELLED')
    AND "shippedAt" IS NULL;
`)

await run('Returns row counts', `
  SELECT
    count(*)::int as total_returns,
    count(*) FILTER (WHERE status = 'PENDING')::int as pending,
    count(*) FILTER (WHERE status = 'INSPECTING')::int as inspecting,
    count(*) FILTER (WHERE status = 'COMPLETED')::int as completed
  FROM "Return";
`)

await run('Order routing rules', `
  SELECT count(*)::int as total_rules,
    count(*) FILTER (WHERE "isActive" = true)::int as active_rules
  FROM "OrderRoutingRule";
`)

await run('Sendcloud / shipping / tracking related tables (existence)', `
  SELECT table_name
  FROM information_schema.tables
  WHERE table_schema = 'public'
    AND (table_name ILIKE '%sendcloud%' OR table_name ILIKE '%tracking%event%' OR table_name ILIKE '%shipping%rule%' OR table_name ILIKE '%shipping%method%' OR table_name ILIKE '%packaging%' OR table_name ILIKE '%customs%')
  ORDER BY table_name;
`)

await run('OrderItem totals + multi-line orders', `
  SELECT
    count(*)::int as total_order_items,
    count(DISTINCT "orderId")::int as distinct_orders,
    round(avg(items_per_order)::numeric, 2) as avg_items_per_order,
    max(items_per_order)::int as max_items_per_order
  FROM (
    SELECT "orderId", count(*) as items_per_order
    FROM "OrderItem"
    GROUP BY "orderId"
  ) i;
`)

await run('Time-to-ship distribution (cycles, last 90d)', `
  SELECT
    count(*)::int as shipped_orders,
    round(avg(extract(epoch from ("shippedAt" - "purchaseDate")) / 3600)::numeric, 2) as avg_hours,
    round((percentile_cont(0.5) within group (order by extract(epoch from ("shippedAt" - "purchaseDate")) / 3600))::numeric, 2) as median_hours,
    round((percentile_cont(0.95) within group (order by extract(epoch from ("shippedAt" - "purchaseDate")) / 3600))::numeric, 2) as p95_hours
  FROM "Order"
  WHERE "shippedAt" IS NOT NULL
    AND "purchaseDate" IS NOT NULL
    AND "shippedAt" > "purchaseDate"
    AND "createdAt" > NOW() - INTERVAL '90 days';
`)

await run('Shipment lifecycle field coverage (data quality)', `
  SELECT
    count(*)::int as total,
    count(*) FILTER (WHERE "pickedAt" IS NOT NULL)::int as ever_picked,
    count(*) FILTER (WHERE "packedAt" IS NOT NULL)::int as ever_packed,
    count(*) FILTER (WHERE "labelPrintedAt" IS NOT NULL)::int as ever_labeled,
    count(*) FILTER (WHERE "shippedAt" IS NOT NULL)::int as ever_shipped,
    count(*) FILTER (WHERE "deliveredAt" IS NOT NULL)::int as ever_delivered,
    count(*) FILTER (WHERE "weightGrams" IS NOT NULL)::int as has_weight,
    count(*) FILTER (WHERE "lengthCm" IS NOT NULL)::int as has_dimensions
  FROM "Shipment";
`)

await client.end()
