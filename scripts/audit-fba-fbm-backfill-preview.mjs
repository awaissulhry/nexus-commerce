#!/usr/bin/env node
// READ-ONLY preview for Fix 4 — the FBA marker backfill. Shows exactly which
// ChannelListing + Product rows would be set to FBA, and the precise UPDATE
// statements the apply step would run. PERFORMS NO WRITES.
//
// Rule: an AMAZON listing/product is FBA-by-truth when it has FBA stock in the
// AMAZON-EU-FBA bucket (>0) or an active FBA Offer. Backfill targets only rows
// that are FBA-by-truth but currently mis-tagged (fulfillmentMethod ≠ 'FBA').
import dotenv from 'dotenv'; import path from 'path'; import { fileURLToPath } from 'url'; import pg from 'pg'
const here = path.dirname(fileURLToPath(import.meta.url)); dotenv.config({ path: path.join(here, '..', '.env') })
const url = process.env.DATABASE_URL?.replace('-pooler', ''); if (!url) { console.error('no DATABASE_URL'); process.exit(1) }
const c = new pg.Client({ connectionString: url }); await c.connect()
const hr = (t) => console.log('\n' + '═'.repeat(74) + '\n' + t + '\n' + '═'.repeat(74))
const Q = async (l, s) => { try { return (await c.query(s)).rows } catch (e) { console.log(`  [${l}] ${e.message}`); return [] } }

const FBA_STOCK = `EXISTS (SELECT 1 FROM "StockLevel" sl JOIN "StockLocation" loc ON loc.id=sl."locationId"
  WHERE sl."productId"=cl."productId" AND loc.code='AMAZON-EU-FBA' AND sl.quantity>0)`
const FBA_OFFER = `EXISTS (SELECT 1 FROM "Offer" o WHERE o."channelListingId"=cl.id
  AND o."fulfillmentMethod"::text='FBA' AND o."isActive")`

hr('SET 1 — ChannelListing rows that would be set fulfillmentMethod=FBA')
const set1 = await Q('set1', `
  SELECT cl.id, p.sku, cl.marketplace mkt, cl."fulfillmentMethod"::text cl_fm,
         p."fulfillmentMethod"::text prod_fm,
         cl."platformAttributes"->'fulfillment_availability'->0->>'fulfillment_channel_code' pa_fch,
         (SELECT COALESCE(SUM(sl.quantity),0) FROM "StockLevel" sl JOIN "StockLocation" loc ON loc.id=sl."locationId"
            WHERE sl."productId"=cl."productId" AND loc.code='AMAZON-EU-FBA') fba_stock,
         ${FBA_OFFER} AS fba_offer
  FROM "ChannelListing" cl JOIN "Product" p ON p.id=cl."productId"
  WHERE cl.channel='AMAZON'
    AND (cl."fulfillmentMethod" IS NULL OR cl."fulfillmentMethod"::text <> 'FBA')
    AND (${FBA_STOCK} OR ${FBA_OFFER})
  ORDER BY p.sku, cl.marketplace`)
console.log(`  rows to update: ${set1.length}`)
set1.forEach(r => console.log(`    ${r.sku} [${r.mkt}]  cl_fm=${r.cl_fm ?? 'NULL'} → FBA   (prod_fm=${r.prod_fm} pa_fch=${r.pa_fch ?? '∅'} fbaStock=${r.fba_stock} fbaOffer=${r.fba_offer})`))

hr('SET 2 — Product rows that would be set fulfillmentMethod=FBA (flat-file re-tagged FBA→FBM)')
const set2 = await Q('set2', `
  SELECT p.id, p.sku, p."fulfillmentMethod"::text prod_fm,
         (SELECT COALESCE(SUM(sl.quantity),0) FROM "StockLevel" sl JOIN "StockLocation" loc ON loc.id=sl."locationId"
            WHERE sl."productId"=p.id AND loc.code='AMAZON-EU-FBA') fba_stock
  FROM "Product" p
  WHERE (p."fulfillmentMethod" IS NULL OR p."fulfillmentMethod"::text <> 'FBA')
    AND EXISTS (SELECT 1 FROM "StockLevel" sl JOIN "StockLocation" loc ON loc.id=sl."locationId"
                WHERE sl."productId"=p.id AND loc.code='AMAZON-EU-FBA' AND sl.quantity>0)
  ORDER BY p.sku`)
console.log(`  rows to update: ${set2.length}`)
set2.forEach(r => console.log(`    ${r.sku}  prod_fm=${r.prod_fm ?? 'NULL'} → FBA   (fbaStock=${r.fba_stock})`))

hr('EXACT UPDATEs the apply step would run (NOT executed here)')
console.log(`
-- SET 1 — ChannelListing
UPDATE "ChannelListing" cl SET "fulfillmentMethod"='FBA'
FROM "Product" p
WHERE p.id=cl."productId" AND cl.channel='AMAZON'
  AND (cl."fulfillmentMethod" IS NULL OR cl."fulfillmentMethod"::text <> 'FBA')
  AND ( EXISTS (SELECT 1 FROM "StockLevel" sl JOIN "StockLocation" loc ON loc.id=sl."locationId"
               WHERE sl."productId"=cl."productId" AND loc.code='AMAZON-EU-FBA' AND sl.quantity>0)
     OR EXISTS (SELECT 1 FROM "Offer" o WHERE o."channelListingId"=cl.id
               AND o."fulfillmentMethod"::text='FBA' AND o."isActive") );

-- SET 2 — Product (only those with FBA stock, i.e. corrupted FBA→FBM)
UPDATE "Product" p SET "fulfillmentMethod"='FBA'
WHERE (p."fulfillmentMethod" IS NULL OR p."fulfillmentMethod"::text <> 'FBA')
  AND EXISTS (SELECT 1 FROM "StockLevel" sl JOIN "StockLocation" loc ON loc.id=sl."locationId"
              WHERE sl."productId"=p.id AND loc.code='AMAZON-EU-FBA' AND sl.quantity>0);`)

await c.end(); console.log('\nDone — READ-ONLY, nothing was written.')
