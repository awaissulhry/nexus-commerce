#!/usr/bin/env node
import dotenv from 'dotenv'
import { fileURLToPath } from 'url'
import path from 'path'
import pg from 'pg'

const here = path.dirname(fileURLToPath(import.meta.url))
dotenv.config({ path: path.join(here, '..', '.env') })

const url = process.env.DATABASE_URL
const c = new pg.Client({ connectionString: url })
await c.connect()

async function run(label, sql, expected) {
  const r = await c.query(sql)
  console.log(`\n=== ${label} ===`)
  console.table(r.rows)
  if (expected) console.log(`expected: ${expected}`)
}

await run('1. Locations seeded', `
  SELECT code, type, "warehouseId", "isActive", cardinality("servesMarketplaces") as markets
  FROM "StockLocation" ORDER BY code
`, '2 rows: IT-MAIN (warehouseId=wh_default_it), AMAZON-EU-FBA (warehouseId=NULL)')

await run('2. StockLevel rows in IT-MAIN', `
  SELECT count(*)::int as n, sum(quantity)::int as total_qty, sum(reserved)::int as total_reserved
  FROM "StockLevel"
  WHERE "locationId" = (SELECT id FROM "StockLocation" WHERE code='IT-MAIN')
`, 'n=109, total_qty=923, total_reserved=0')

await run('3. Total StockLevel rows', `SELECT count(*)::int as n FROM "StockLevel"`, 'n=109 (no FBA rows yet)')

await run('4. Drift between Product.totalStock and SUM(StockLevel) — should be 0', `
  SELECT count(*)::int as drift_count
  FROM (
    SELECT p.id, p."totalStock", COALESCE(SUM(sl.quantity), 0)::int as sl_sum
    FROM "Product" p
    LEFT JOIN "StockLevel" sl ON sl."productId" = p.id
    WHERE p."isParent" = false
    GROUP BY p.id, p."totalStock"
    HAVING p."totalStock" != COALESCE(SUM(sl.quantity), 0)
  ) drift
`, 'drift_count=0')

await run('5. Parents with non-zero stock — should be 0', `
  SELECT count(*)::int as n FROM "Product" WHERE "isParent" = true AND "totalStock" > 0
`, 'n=0')

await run('6. Audit trail completeness', `
  SELECT reason::text, count(*)::int as n
  FROM "StockMovement" WHERE actor = 'system:migration_h1_stock_locations'
  GROUP BY reason ORDER BY reason
`, 'PARENT_PRODUCT_CLEANUP=10, STOCKLEVEL_BACKFILL=109')

await run('6b. Audit trail totals', `
  SELECT count(*)::int as total_movements, sum(change)::int as net_change
  FROM "StockMovement" WHERE actor = 'system:migration_h1_stock_locations'
`, 'total=119, net_change=923 - 790 = 133')

await run('7. CHECK invariant — should be 0', `
  SELECT count(*)::int as bad_rows FROM "StockLevel" WHERE "available" != ("quantity" - "reserved")
`, 'bad_rows=0')

await run('8. FBA reconciliation candidates (post-deploy review)', `
  SELECT count(*)::int as candidates
  FROM "Product" p
  WHERE p."isParent" = false AND p."totalStock" > 0 AND p."amazonAsin" IS NOT NULL
`, 'count of SKUs that may need manual reconciliation after first cron run')

await run('9. Product.totalStock totals', `
  SELECT
    sum("totalStock") FILTER (WHERE "isParent" = false)::int as buyable_total,
    sum("totalStock") FILTER (WHERE "isParent" = true)::int as parent_total
  FROM "Product"
`, 'buyable_total=923, parent_total=0')

await c.end()
