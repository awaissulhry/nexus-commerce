import dotenv from 'dotenv'
import path from 'path'
import { fileURLToPath } from 'url'
import pg from 'pg'
const here = path.dirname(fileURLToPath(import.meta.url))
dotenv.config({ path: path.join(here, '..', '.env') })
const c = new pg.Client({ connectionString: process.env.DATABASE_URL })
await c.connect()
const r = await c.query(`
  SELECT marketplace, status, count(*) AS orders, sum("totalPrice")::numeric(10,2) AS total
  FROM "Order"
  WHERE channel='AMAZON' AND "deletedAt" IS NULL
    AND "purchaseDate" >= '2026-05-20T22:00:00Z'
    AND "purchaseDate" <  '2026-05-21T22:00:00Z'
  GROUP BY marketplace, status
  ORDER BY marketplace, status;
`)
console.table(r.rows)
await c.end()
