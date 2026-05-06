#!/usr/bin/env node
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

await run('Tables present', `
  SELECT table_name FROM information_schema.tables
  WHERE table_schema='public'
  AND table_name IN ('InboundShipment','InboundShipmentItem','PurchaseOrder','PurchaseOrderItem','Supplier','SupplierProduct','Carrier','FBAShipment','FBAShipmentItem','WorkOrder')
  ORDER BY table_name
`)

await run('InboundShipment status breakdown', `
  SELECT type::text as type, status::text as status, count(*)::int as n
  FROM "InboundShipment"
  GROUP BY type, status
  ORDER BY type, status
`)

await run('InboundShipment age (created at)', `
  SELECT status::text as status,
    count(*)::int as n,
    EXTRACT(epoch FROM avg(now() - "createdAt"))/86400 as avg_days_old,
    EXTRACT(epoch FROM max(now() - "createdAt"))/86400 as oldest_days
  FROM "InboundShipment"
  GROUP BY status
`)

await run('InboundShipmentItem rows', `
  SELECT count(*)::int as items,
    coalesce(sum("quantityExpected"),0)::int as expected_total,
    coalesce(sum("quantityReceived"),0)::int as received_total,
    count(*) FILTER (WHERE "qcStatus" IS NOT NULL)::int as with_qc
  FROM "InboundShipmentItem"
`)

await run('Items per shipment + receive progress', `
  SELECT
    s.id, s.type::text, s.status::text, s.reference,
    count(i.id)::int as items,
    coalesce(sum(i."quantityExpected"),0)::int as expected,
    coalesce(sum(i."quantityReceived"),0)::int as received,
    s."createdAt"
  FROM "InboundShipment" s
  LEFT JOIN "InboundShipmentItem" i ON i."inboundShipmentId" = s.id
  GROUP BY s.id
  ORDER BY s."createdAt" DESC
  LIMIT 10
`)

await run('PurchaseOrder + items', `
  SELECT
    (SELECT count(*) FROM "PurchaseOrder") as pos,
    (SELECT count(*) FROM "PurchaseOrderItem") as po_items,
    (SELECT count(*) FROM "PurchaseOrder" WHERE status='DRAFT') as draft,
    (SELECT count(*) FROM "PurchaseOrder" WHERE status='SUBMITTED') as submitted,
    (SELECT count(*) FROM "PurchaseOrder" WHERE status='RECEIVED') as received
`)

await run('Supplier + SupplierProduct', `
  SELECT
    (SELECT count(*) FROM "Supplier")::int as suppliers,
    (SELECT count(*) FROM "Supplier" WHERE "isActive")::int as active,
    (SELECT count(*) FROM "SupplierProduct")::int as supplier_products
`)

await run('Carrier rows', `
  SELECT code::text as code, name, "isActive"
  FROM "Carrier" ORDER BY code
`)

await run('FBAShipment + FBAShipmentItem', `
  SELECT
    (SELECT count(*) FROM "FBAShipment")::int as fba_shipments,
    (SELECT count(*) FROM "FBAShipmentItem")::int as fba_items
`)

await run('Inbound → Stock receipt linkage (StockMovement audit completeness)', `
  SELECT count(*)::int as receipts_via_inbound
  FROM "StockMovement"
  WHERE "referenceType" = 'InboundShipment'
`)

await run('Schema columns — InboundShipment', `
  SELECT column_name, data_type, is_nullable
  FROM information_schema.columns
  WHERE table_name = 'InboundShipment' AND table_schema = 'public'
  ORDER BY ordinal_position
`)

await run('Schema columns — InboundShipmentItem', `
  SELECT column_name, data_type, is_nullable
  FROM information_schema.columns
  WHERE table_name = 'InboundShipmentItem' AND table_schema = 'public'
  ORDER BY ordinal_position
`)

await c.end()
