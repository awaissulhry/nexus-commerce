import 'dotenv/config'
import { config } from 'dotenv'
import { resolve } from 'path'
config({ path: resolve(process.cwd(), '../../.env') })
import pg from 'pg'

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 1, connectionTimeoutMillis: 20000 })

const parentRes = await pool.query(
  `SELECT id, sku, name, "basePrice", "totalStock", "amazonAsin" FROM "Product" WHERE sku = $1`,
  ['3K-HP05-BH9I']
)
const parent = parentRes.rows[0]
console.log('PARENT:', JSON.stringify(parent))

const childRes = await pool.query(
  `SELECT id, sku, name, "basePrice", "totalStock", "amazonAsin", "fulfillmentChannel", status, "variantAttributes", "deletedAt"
   FROM "Product" WHERE "parentId" = $1 ORDER BY sku`,
  [parent.id]
)
console.log('CHILD COUNT:', childRes.rows.length)
for (const r of childRes.rows) console.log(JSON.stringify(r))

// Channel listings for these children
const childIds = childRes.rows.map(r => r.id)
const clRes = await pool.query(
  `SELECT "productId", channel, marketplace, "externalListingId", "listingStatus", price, "isPublished"
   FROM "ChannelListing" WHERE "productId" = ANY($1) ORDER BY "productId", channel, marketplace`,
  [childIds]
)
console.log('CHANNEL LISTINGS COUNT:', clRes.rows.length)
for (const r of clRes.rows) console.log(JSON.stringify(r))

await pool.end()
