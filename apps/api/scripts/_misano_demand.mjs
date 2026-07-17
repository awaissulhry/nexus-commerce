import 'dotenv/config'
import { config } from 'dotenv'
import { resolve } from 'path'
config({ path: resolve(process.cwd(), '../../.env') })
import pg from 'pg'

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 1, connectionTimeoutMillis: 20000 })

const SKUS = [
  ['85-A8DQ-UNYF','S','BLACK'],
  ['MISANO-JACKET-XS-BLACK','XS','BLACK'],
  ['SQ-75VQ-OZ1Q','M','BLACK'],
  ['AE-304M-9LSW','L','BLACK'],
  ['SQ-0SRL-MWT1','XL','BLACK'],
  ['YK-29A3-CH9D','2XL','BLACK'],
  ['MISANO-JACKET-3XL-BLACK','3XL','BLACK'],
  ['MISANO-JACKET-4XL-BLACK','4XL','BLACK'],
  ['MISANO-JACKET-5XL-BLACK','5XL','BLACK'],
  ['MISANO-JACKET-XS-BROWN','XS','BROWN'],
  ['MISANO-JACKET-S-BROWN','S','BROWN'],
  ['MISANO-JACKET-M-BROWN','M','BROWN'],
  ['MISANO-JACKET-L-BROWN','L','BROWN'],
  ['MISANO-JACKET-XL-BROWN','XL','BROWN'],
  ['MISANO-JACKET-XXL-BROWN','2XL','BROWN'],
]
const skuList = SKUS.map(s => s[0])

// Sold: OrderItem joined to Order, Amazon channel only, non-cancelled
const soldRes = await pool.query(
  `SELECT oi.sku, o.marketplace, date_trunc('month', COALESCE(o."purchaseDate", o."createdAt")) as month,
          SUM(oi.quantity)::int as units, COUNT(DISTINCT o.id)::int as orders, o.status
   FROM "OrderItem" oi
   JOIN "Order" o ON o.id = oi."orderId"
   WHERE oi.sku = ANY($1) AND o.channel = 'AMAZON'
   GROUP BY oi.sku, o.marketplace, month, o.status
   ORDER BY oi.sku, month`,
  [skuList]
)
console.log('--- SOLD (OrderItem, monthly, by status) ---')
for (const r of soldRes.rows) console.log(JSON.stringify(r))

const retRes = await pool.query(
  `SELECT ri.sku, r.marketplace, date_trunc('month', COALESCE(r."receivedAt", r."createdAt")) as month,
          SUM(ri.quantity)::int as units, r.status
   FROM "ReturnItem" ri
   JOIN "Return" r ON r.id = ri."returnId"
   WHERE ri.sku = ANY($1) AND r.channel = 'AMAZON'
   GROUP BY ri.sku, r.marketplace, month, r.status
   ORDER BY ri.sku, month`,
  [skuList]
)
console.log('--- RETURNS (ReturnItem, monthly) ---')
for (const r of retRes.rows) console.log(JSON.stringify(r))

// Date range sanity
const rangeRes = await pool.query(
  `SELECT min(COALESCE(o."purchaseDate", o."createdAt")) as earliest, max(COALESCE(o."purchaseDate", o."createdAt")) as latest, count(*)::int as n
   FROM "Order" o WHERE o.channel = 'AMAZON'`
)
console.log('--- ORDER DATE RANGE (all Amazon orders, sanity) ---', JSON.stringify(rangeRes.rows[0]))

await pool.end()
