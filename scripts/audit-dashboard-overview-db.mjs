#!/usr/bin/env node
// /dashboard/overview audit (read-only).
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

await run('1. Order totals (today/7d/30d/90d/lifetime)', `
  SELECT
    count(*) FILTER (WHERE "createdAt" >= date_trunc('day', NOW())) AS today,
    count(*) FILTER (WHERE "createdAt" > NOW() - INTERVAL '7 days') AS d7,
    count(*) FILTER (WHERE "createdAt" > NOW() - INTERVAL '30 days') AS d30,
    count(*) FILTER (WHERE "createdAt" > NOW() - INTERVAL '90 days') AS d90,
    count(*) AS lifetime
  FROM "Order"
`)

await run('2. Revenue totals + AOV (30d window)', `
  SELECT
    COALESCE(SUM("totalPrice"),0)::numeric(12,2) AS revenue_30d,
    COALESCE(AVG("totalPrice"),0)::numeric(8,2)  AS aov_30d,
    count(*) AS orders_30d,
    count(DISTINCT "customerId") AS customers_30d,
    count(DISTINCT currency) AS currencies
  FROM "Order"
  WHERE "createdAt" > NOW() - INTERVAL '30 days'
`)

await run('3. Currency distribution (30d)', `
  SELECT currency, count(*) AS orders, COALESCE(SUM("totalPrice"),0)::numeric(12,2) AS rev
  FROM "Order"
  WHERE "createdAt" > NOW() - INTERVAL '30 days'
  GROUP BY currency
  ORDER BY rev DESC
`)

await run('4. Per-channel × marketplace (30d)', `
  SELECT channel, marketplace,
         count(*) AS orders,
         COALESCE(SUM("totalPrice"),0)::numeric(12,2) AS revenue,
         COALESCE(AVG("totalPrice"),0)::numeric(8,2) AS aov
  FROM "Order"
  WHERE "createdAt" > NOW() - INTERVAL '30 days'
  GROUP BY channel, marketplace
  ORDER BY revenue DESC NULLS LAST
`)

await run('5. ChannelListing state', `
  SELECT "listingStatus", count(*) AS n FROM "ChannelListing"
  GROUP BY "listingStatus" ORDER BY n DESC
`)

await run('6. ChannelListing by channel + status', `
  SELECT channel, "listingStatus", count(*)
  FROM "ChannelListing"
  GROUP BY channel, "listingStatus"
  ORDER BY channel, "listingStatus"
`)

await run('7. Product counts', `
  SELECT
    count(*) AS total,
    count(*) FILTER (WHERE status='ACTIVE') AS active,
    count(*) FILTER (WHERE status='DRAFT') AS draft,
    count(*) FILTER (WHERE "isParent"=true) AS parents,
    count(*) FILTER (WHERE "totalStock" <= 0) AS oos,
    count(*) FILTER (WHERE "totalStock" > 0 AND "totalStock" <= 10) AS low_stock,
    count(DISTINCT brand) AS brands
  FROM "Product"
`)

await run('8. ChannelConnection state', `
  SELECT "channelType", "isActive", "lastSyncStatus", count(*)
  FROM "ChannelConnection"
  GROUP BY "channelType", "isActive", "lastSyncStatus"
  ORDER BY "channelType"
`)

await run('9. Sync health volumes', `
  SELECT 'sync_log_24h_total' AS k, count(*)::text AS v FROM "SyncLog" WHERE "createdAt" > NOW() - INTERVAL '24 hours'
  UNION ALL
  SELECT 'sync_log_24h_FAILED', count(*)::text FROM "SyncLog" WHERE "createdAt" > NOW() - INTERVAL '24 hours' AND status='FAILED'
  UNION ALL
  SELECT 'sync_error_24h', count(*)::text FROM "SyncError" WHERE "createdAt" > NOW() - INTERVAL '24 hours'
  UNION ALL
  SELECT 'outbound_PENDING', count(*)::text FROM "OutboundSyncQueue" WHERE "syncStatus"='PENDING'
  UNION ALL
  SELECT 'outbound_FAILED', count(*)::text FROM "OutboundSyncQueue" WHERE "syncStatus"='FAILED'
  UNION ALL
  SELECT 'auditLog_24h', count(*)::text FROM "AuditLog" WHERE "createdAt" > NOW() - INTERVAL '24 hours'
  UNION ALL
  SELECT 'bulkOps_24h', count(*)::text FROM "BulkOperation" WHERE "createdAt" > NOW() - INTERVAL '24 hours'
`)

await run('10. Order status (live + late)', `
  SELECT status, count(*) FROM "Order" GROUP BY status ORDER BY count(*) DESC
`)

await run('11. Late shipments (PENDING + past expected ship date)', `
  SELECT count(*) FROM "Order"
  WHERE status='PENDING' AND "expectedShipDate" IS NOT NULL AND "expectedShipDate" < NOW()
`)

await run('12. Returns (last 30d)', `
  SELECT count(*) FROM "Return"
  WHERE "createdAt" > NOW() - INTERVAL '30 days'
`)

await run('13. Discover relevant tables', `
  SELECT table_name
  FROM information_schema.tables
  WHERE table_schema='public' AND (
    table_name ILIKE '%kpi%' OR table_name ILIKE '%snapshot%' OR
    table_name ILIKE '%metric%' OR table_name ILIKE '%alert%' OR
    table_name ILIKE '%notification%' OR table_name ILIKE '%dashboard%' OR
    table_name ILIKE '%customer%' OR table_name ILIKE '%return%' OR
    table_name ILIKE '%goal%' OR table_name ILIKE '%refund%' OR
    table_name ILIKE '%shipment%' OR table_name ILIKE '%payout%' OR
    table_name ILIKE '%review%' OR table_name ILIKE '%suppression%')
  ORDER BY table_name
`)

await run('14. Top SKUs revenue (30d)', `
  SELECT oi.sku, p.name,
         SUM(oi.quantity)::int AS units,
         COALESCE(SUM(oi."price" * oi.quantity), 0)::numeric(12,2) AS revenue
  FROM "OrderItem" oi
  JOIN "Order" o ON o.id = oi."orderId"
  LEFT JOIN "Product" p ON p.id = oi."productId"
  WHERE o."createdAt" > NOW() - INTERVAL '30 days'
  GROUP BY oi.sku, p.name
  ORDER BY revenue DESC
  LIMIT 10
`)

await run('15. Per-day trend (30d)', `
  SELECT to_char(date_trunc('day', "createdAt"),'YYYY-MM-DD') AS day,
         count(*) AS orders, COALESCE(SUM("totalPrice"),0)::numeric(12,2) AS rev
  FROM "Order"
  WHERE "createdAt" > NOW() - INTERVAL '30 days'
  GROUP BY 1 ORDER BY 1
`)

await run('16. Customer table presence + counts', `
  SELECT
    EXISTS(SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='Customer') AS has_customer
`)

await run('17. CronRun health', `
  SELECT "jobName", count(*) AS runs,
         count(*) FILTER (WHERE status='FAILED') AS failed,
         max("startedAt") AS last_run
  FROM "CronRun"
  WHERE "startedAt" > NOW() - INTERVAL '7 days'
  GROUP BY "jobName"
  ORDER BY last_run DESC NULLS LAST
  LIMIT 30
`)

await run('18. Stock invariants snapshot (totalStock distribution)', `
  SELECT
    count(*) FILTER (WHERE "totalStock" IS NULL) AS null_stock,
    count(*) FILTER (WHERE "totalStock" = 0) AS zero,
    count(*) FILTER (WHERE "totalStock" BETWEEN 1 AND 10) AS low,
    count(*) FILTER (WHERE "totalStock" > 10) AS healthy
  FROM "Product"
  WHERE "isParent"=false AND status='ACTIVE'
`)

await c.end()
