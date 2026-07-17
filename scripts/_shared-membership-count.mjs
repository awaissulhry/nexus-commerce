// Read-only diagnostic: count existing SharedListingMembership rows on prod.
import dotenv from 'dotenv'
import path from 'path'
import { fileURLToPath } from 'url'
import pg from 'pg'

const here = path.dirname(fileURLToPath(import.meta.url))
dotenv.config({ path: path.join(here, '..', '.env') })
const url = process.env.DATABASE_URL?.replace('-pooler', '')
if (!url) { console.error('DATABASE_URL missing'); process.exit(1) }
const c = new pg.Client({ connectionString: url })
await c.connect()
try {
  const total = await c.query(`SELECT COUNT(*)::int n FROM "SharedListingMembership"`)
  const active = await c.query(`SELECT COUNT(*)::int n, COUNT(DISTINCT "parentSku")::int parents, COUNT(DISTINCT sku)::int skus, COUNT(*) FILTER (WHERE "productId" IS NULL)::int null_pid, COUNT(*) FILTER (WHERE price IS NOT NULL)::int with_price FROM "SharedListingMembership" WHERE status='ACTIVE'`)
  console.log('SharedListingMembership total rows:', total.rows[0].n)
  console.log('ACTIVE:', JSON.stringify(active.rows[0]))
  const multi = await c.query(`SELECT sku, COUNT(DISTINCT "parentSku")::int parents FROM "SharedListingMembership" WHERE status='ACTIVE' GROUP BY sku HAVING COUNT(DISTINCT "parentSku") >= 2 LIMIT 5`)
  console.log('SKUs shared across >=2 parents (round-trip cases):', multi.rowCount, multi.rows.map(r => `${r.sku}(${r.parents})`).join(', ') || '(none)')
} finally {
  await c.end()
}
