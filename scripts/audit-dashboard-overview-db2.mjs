#!/usr/bin/env node
import dotenv from 'dotenv'
import { fileURLToPath } from 'url'
import path from 'path'
import pg from 'pg'

const here = path.dirname(fileURLToPath(import.meta.url))
dotenv.config({ path: path.join(here, '..', '.env') })

const c = new pg.Client({ connectionString: process.env.DATABASE_URL })
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

await run('Order columns (sample)', `
  SELECT column_name, data_type FROM information_schema.columns
  WHERE table_name='Order'
  ORDER BY ordinal_position
`)

await run('Shipment columns (sample)', `
  SELECT column_name, data_type FROM information_schema.columns
  WHERE table_name='Shipment'
  ORDER BY ordinal_position
  LIMIT 30
`)

await run('AmazonSuppression columns', `
  SELECT column_name FROM information_schema.columns
  WHERE table_name='AmazonSuppression'
`)

await run('Customer + CustomerAddress + Notification counts', `
  SELECT 'customers' AS k, count(*)::text AS v FROM "Customer"
  UNION ALL SELECT 'customers_30d', count(*)::text FROM "Customer" WHERE "createdAt" > NOW() - INTERVAL '30 days'
  UNION ALL SELECT 'customer_addresses', count(*)::text FROM "CustomerAddress"
  UNION ALL SELECT 'notifications', count(*)::text FROM "Notification"
  UNION ALL SELECT 'notifications_unread', count(*)::text FROM "Notification" WHERE "readAt" IS NULL
  UNION ALL SELECT 'shipments', count(*)::text FROM "Shipment"
  UNION ALL SELECT 'returns', count(*)::text FROM "Return"
  UNION ALL SELECT 'refunds', count(*)::text FROM "Refund"
  UNION ALL SELECT 'amazon_suppressions', count(*)::text FROM "AmazonSuppression"
  UNION ALL SELECT 'review_requests', count(*)::text FROM "ReviewRequest"
  UNION ALL SELECT 'fba_shipments', count(*)::text FROM "FBAShipment"
`)

await run('SavedViewAlert state', `
  SELECT count(*) FROM "SavedViewAlert"
`)

await run('Order shipping fields probe', `
  SELECT id, status, channel, "shippingService", "shippedAt", "deliveredAt"
  FROM "Order" LIMIT 3
`)

await run('Order: shipBy / SLA columns search', `
  SELECT column_name FROM information_schema.columns
  WHERE table_name='Order' AND (
    column_name ILIKE '%ship%' OR column_name ILIKE '%late%' OR column_name ILIKE '%due%' OR column_name ILIKE '%sla%')
`)

await run('Late shipment (using shipByDate guess)', `
  SELECT count(*) AS n FROM "Order"
  WHERE status IN ('PENDING','PROCESSING') AND "shipByDate" IS NOT NULL AND "shipByDate" < NOW()
`)

await run('Late risk via outbound queue (Shipment with lateRisk)', `
  SELECT column_name FROM information_schema.columns
  WHERE table_name='Shipment' AND (
    column_name ILIKE '%late%' OR column_name ILIKE '%risk%' OR column_name ILIKE '%due%' OR column_name ILIKE '%sla%')
`)

await c.end()
