// _inv-split-12-echeck.mjs — list eBay listings whose published qty exceeds
// warehouse AVAILABLE (reserved-aware). Read-only. Characterises the residual
// that Phase 1.2 (available-based write path) must close.
import { PrismaClient } from '@prisma/client'
import { config } from 'dotenv'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
config({ path: join(dirname(fileURLToPath(import.meta.url)), '..', '.env') })
const p = new PrismaClient()
const rows = await p.$queryRawUnsafe(`
  SELECT pr.sku, c.marketplace, c.quantity AS ebay_qty, c."externalListingId" AS item_id,
    COALESCE((SELECT SUM(s.quantity)::int  FROM "StockLevel" s JOIN "StockLocation" l ON l.id=s."locationId" WHERE s."productId"=c."productId" AND l.type='WAREHOUSE'),0) AS wh_qty,
    COALESCE((SELECT SUM(s.available)::int FROM "StockLevel" s JOIN "StockLocation" l ON l.id=s."locationId" WHERE s."productId"=c."productId" AND l.type='WAREHOUSE'),0) AS wh_avail,
    COALESCE((SELECT SUM(s.reserved)::int  FROM "StockLevel" s JOIN "StockLocation" l ON l.id=s."locationId" WHERE s."productId"=c."productId" AND l.type='WAREHOUSE'),0) AS wh_reserved
  FROM "ChannelListing" c JOIN "Product" pr ON pr.id=c."productId"
  WHERE c.channel='EBAY' AND c.quantity IS NOT NULL
    AND c.quantity > COALESCE((SELECT SUM(s.available)::int FROM "StockLevel" s JOIN "StockLocation" l ON l.id=s."locationId" WHERE s."productId"=c."productId" AND l.type='WAREHOUSE'),0)
  ORDER BY pr.sku
`)
console.log(JSON.stringify(rows, (k, v) => (typeof v === 'bigint' ? Number(v) : v), 2))
await p.$disconnect()
