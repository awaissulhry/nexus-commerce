// One-shot: populate Product.brand = 'Xavia' for all products where brand IS NULL.
// Safe to re-run: only touches rows with brand IS NULL; skips already-set rows.
import dotenv from 'dotenv'
import path from 'path'
import { fileURLToPath } from 'url'
import pg from 'pg'

const here = path.dirname(fileURLToPath(import.meta.url))
dotenv.config({ path: path.join(here, '..', '.env') })

const url = process.env.DATABASE_URL?.replace('-pooler', '')
if (!url) { console.error('DATABASE_URL not set'); process.exit(1) }

const c = new pg.Client({ connectionString: url })
await c.connect()

const { rows: nullRows } = await c.query(
  `SELECT COUNT(*) AS n FROM "Product" WHERE brand IS NULL AND "deletedAt" IS NULL`
)
console.log(`Products with null brand: ${nullRows[0].n}`)

const { rowCount } = await c.query(
  `UPDATE "Product" SET brand = 'Xavia' WHERE brand IS NULL AND "deletedAt" IS NULL`
)
console.log(`Updated ${rowCount} products → brand = 'Xavia'`)

await c.end()
