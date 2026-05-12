import dotenv from 'dotenv'
import { fileURLToPath } from 'url'
import path from 'path'
import pg from 'pg'
const here = path.dirname(fileURLToPath(import.meta.url))
dotenv.config({ path: path.join(here, '..', '.env') })
let url = process.env.DATABASE_URL
url = url.replace('-pooler', '')
const c = new pg.Client({ connectionString: url })
await c.connect()
const r1 = await c.query(`SELECT count(*) AS orders, count(*) FILTER (WHERE status != 'CANCELLED') AS non_cancelled, MIN("purchaseDate") AS earliest, MAX("purchaseDate") AS latest FROM "Order"`)
console.log('Order table state:'); console.table(r1.rows)
const r2 = await c.query(`SELECT channel, count(*) AS orders FROM "Order" WHERE status != 'CANCELLED' GROUP BY channel ORDER BY count(*) DESC`)
console.log('Orders by channel:'); console.table(r2.rows)
const r3 = await c.query(`SELECT count(*) AS items, count(DISTINCT sku) AS unique_skus FROM "OrderItem"`)
console.log('OrderItem state:'); console.table(r3.rows)
const r4 = await c.query(`SELECT to_char(o."purchaseDate", 'YYYY-MM') AS month, count(DISTINCT o.id) AS orders, count(oi.id) AS items FROM "Order" o LEFT JOIN "OrderItem" oi ON oi."orderId" = o.id WHERE o."purchaseDate" > NOW() - INTERVAL '12 months' AND o.status != 'CANCELLED' GROUP BY 1 ORDER BY 1 DESC LIMIT 13`)
console.log('Order volume by month (12mo):'); console.table(r4.rows)
await c.end()
