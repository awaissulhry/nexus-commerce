#!/usr/bin/env node
// H.1 pre-flight verification — read-only.
import dotenv from 'dotenv'
import { fileURLToPath } from 'url'
import path from 'path'
import pg from 'pg'

const here = path.dirname(fileURLToPath(import.meta.url))
dotenv.config({ path: path.join(here, '..', '.env') })

const url = process.env.DATABASE_URL
if (!url) { console.error('DATABASE_URL missing'); process.exit(1) }

const client = new pg.Client({ connectionString: url })
await client.connect()

const r = await client.query(`
  SELECT
    (SELECT count(*) FROM "Product" WHERE "isParent" = false AND "totalStock" > 0)::int as buyable_with_stock,
    (SELECT sum("totalStock") FROM "Product" WHERE "isParent" = false)::int as buyable_total,
    (SELECT count(*) FROM "Product" WHERE "isParent" = true AND "totalStock" > 0)::int as parents_with_stock,
    (SELECT sum("totalStock") FROM "Product" WHERE "isParent" = true)::int as parent_total,
    (SELECT count(*) FROM "StockMovement")::int as existing_movements,
    (SELECT count(*) FROM "Warehouse")::int as warehouses,
    (SELECT count(*) FROM "ProductVariation")::int as variations,
    (SELECT EXISTS(SELECT 1 FROM information_schema.tables WHERE table_name='StockLocation'))::bool as stocklocation_exists
`)
console.table(r.rows)
await client.end()
