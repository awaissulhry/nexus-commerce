// _inv-split-10-audit.mjs — Phase 1.0 READ-ONLY audit of split-inventory state.
// Confirms whether eBay published quantity is being driven by Amazon FBA stock.
// SELECT-only. Safe to run against prod.
import { PrismaClient } from '@prisma/client'
import { config } from 'dotenv'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
config({ path: join(dirname(fileURLToPath(import.meta.url)), '..', '.env') })

const p = new PrismaClient()
const j = (x) => JSON.stringify(x, (_k, v) => (typeof v === 'bigint' ? Number(v) : v), 2)

async function q(label, sql) {
  try {
    const rows = await p.$queryRawUnsafe(sql)
    console.log(`\n=== ${label} ===`)
    console.log(j(rows))
  } catch (e) {
    console.log(`\n=== ${label} === ERROR: ${e.message}`)
  }
}

console.log('Phase 1.0 — split-inventory live audit (read-only)')

await q('A. StockLocation types + stock held', `
  SELECT sl.type,
         count(DISTINCT sl.id)::int AS locations,
         count(s.id)::int AS stocklevel_rows,
         COALESCE(SUM(s.quantity),0)::int AS sum_quantity,
         COALESCE(SUM(s.available),0)::int AS sum_available
  FROM "StockLocation" sl
  LEFT JOIN "StockLevel" s ON s."locationId" = sl.id
  GROUP BY sl.type
  ORDER BY sl.type
`)

await q('B. Is FBA stock present in StockLevel, and does totalStock include it?', `
  SELECT
    count(*)::int AS products_with_stock,
    count(*) FILTER (WHERE fba_sl_qty > 0)::int AS products_with_fba_in_stocklevel,
    count(*) FILTER (WHERE total_stock <> wh_qty)::int AS products_totalstock_ne_warehouse,
    count(*) FILTER (WHERE total_stock = wh_qty + fba_sl_qty AND fba_sl_qty > 0)::int AS products_totalstock_eq_wh_plus_fba
  FROM (
    SELECT p.id,
      p."totalStock" AS total_stock,
      COALESCE(SUM(s.quantity) FILTER (WHERE loc.type='WAREHOUSE'),0)::int AS wh_qty,
      COALESCE(SUM(s.quantity) FILTER (WHERE loc.type='AMAZON_FBA'),0)::int AS fba_sl_qty
    FROM "Product" p
    JOIN "StockLevel" s ON s."productId" = p.id
    JOIN "StockLocation" loc ON loc.id = s."locationId"
    GROUP BY p.id, p."totalStock"
  ) t
`)

await q('C. eBay listing fulfillmentMethod x followMasterQuantity', `
  SELECT COALESCE("fulfillmentMethod"::text,'(null)') AS fulfillment_method,
         "followMasterQuantity" AS follow_master_qty,
         count(*)::int AS listings
  FROM "ChannelListing"
  WHERE channel='EBAY'
  GROUP BY 1,2
  ORDER BY 1,2
`)

await q('D. Products w/ eBay listing AND FBA presence — does eBay qty track warehouse or FBA?', `
  SELECT p.sku,
    p."totalStock" AS total_stock,
    COALESCE((SELECT SUM(s.quantity)::int FROM "StockLevel" s JOIN "StockLocation" l ON l.id=s."locationId" WHERE s."productId"=p.id AND l.type='WAREHOUSE'),0) AS wh_qty,
    COALESCE((SELECT SUM(s.available)::int FROM "StockLevel" s JOIN "StockLocation" l ON l.id=s."locationId" WHERE s."productId"=p.id AND l.type='WAREHOUSE'),0) AS wh_avail,
    COALESCE((SELECT SUM(s.quantity)::int FROM "StockLevel" s JOIN "StockLocation" l ON l.id=s."locationId" WHERE s."productId"=p.id AND l.type='AMAZON_FBA'),0) AS fba_stocklevel,
    COALESCE((SELECT SUM(f.quantity)::int FROM "FbaInventoryDetail" f WHERE f."productId"=p.id AND f.condition='SELLABLE'),0) AS fba_sellable,
    (SELECT json_agg(json_build_object('mkt',c.marketplace,'qty',c.quantity,'fm',c."fulfillmentMethod",'follow',c."followMasterQuantity",'buf',c."stockBuffer") ORDER BY c.marketplace)
       FROM "ChannelListing" c WHERE c."productId"=p.id AND c.channel='EBAY') AS ebay_listings
  FROM "Product" p
  WHERE EXISTS (SELECT 1 FROM "ChannelListing" c WHERE c."productId"=p.id AND c.channel='EBAY')
    AND (EXISTS (SELECT 1 FROM "FbaInventoryDetail" f WHERE f."productId"=p.id AND f.condition='SELLABLE' AND f.quantity>0)
         OR EXISTS (SELECT 1 FROM "StockLevel" s JOIN "StockLocation" l ON l.id=s."locationId" WHERE s."productId"=p.id AND l.type='AMAZON_FBA' AND s.quantity>0))
  ORDER BY p.sku
  LIMIT 30
`)

await q('E. eBay listings whose published qty exceeds warehouse available (oversell signature)', `
  SELECT count(*)::int AS ebay_listings_over_warehouse
  FROM "ChannelListing" c
  WHERE c.channel='EBAY' AND c.quantity IS NOT NULL
    AND c.quantity > COALESCE((SELECT SUM(s.available)::int FROM "StockLevel" s JOIN "StockLocation" l ON l.id=s."locationId" WHERE s."productId"=c."productId" AND l.type='WAREHOUSE'),0)
`)

await p.$disconnect()
console.log('\nDone.')
