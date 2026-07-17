// Read-only: what variation theme/axes does a parent SKU actually have?
import dotenv from 'dotenv'; import path from 'path'; import { fileURLToPath } from 'url'; import pg from 'pg'
const here = path.dirname(fileURLToPath(import.meta.url))
dotenv.config({ path: path.join(here, '..', '.env') })
const url = process.env.DATABASE_URL?.replace('-pooler', '')
const sku = process.argv[2] || 'WATERPROOF-OVERJACKET-BLACK-MEN'
const c = new pg.Client({ connectionString: url }); await c.connect()
try {
  const p = await c.query(`SELECT id, sku, "isParent", "parentId", "variationTheme", "variationAxes" FROM "Product" WHERE sku=$1 AND "deletedAt" IS NULL`, [sku])
  console.log('PARENT:', JSON.stringify(p.rows[0] ?? '(not found)'))
  if (p.rows[0]) {
    const kids = await c.query(`SELECT sku, "variantAttributes" FROM "Product" WHERE "parentId"=$1 AND "deletedAt" IS NULL ORDER BY sku LIMIT 6`, [p.rows[0].id])
    console.log('CHILDREN sample:', kids.rowCount)
    for (const k of kids.rows) console.log('  ', k.sku, '→', JSON.stringify(k.variantAttributes))
  }
} finally { await c.end() }
