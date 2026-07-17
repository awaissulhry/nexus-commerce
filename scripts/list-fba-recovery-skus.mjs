#!/usr/bin/env node
// READ-ONLY: the Fix 5 recovery worklist — Amazon listings backed by FBA stock
// (the ones flipped to FBM that need converting back to FBA). Grouped by SKU.
import dotenv from 'dotenv'; import path from 'path'; import { fileURLToPath } from 'url'; import pg from 'pg'
const here = path.dirname(fileURLToPath(import.meta.url)); dotenv.config({ path: path.join(here, '..', '.env') })
const url = process.env.DATABASE_URL?.replace('-pooler', ''); if (!url) { console.error('no DATABASE_URL'); process.exit(1) }
const c = new pg.Client({ connectionString: url }); await c.connect()
const rows = (await c.query(`
  SELECT p.sku, cl.marketplace AS mkt,
    (SELECT COALESCE(SUM(sl.quantity),0) FROM "StockLevel" sl JOIN "StockLocation" loc ON loc.id=sl."locationId"
       WHERE sl."productId"=cl."productId" AND loc.code='AMAZON-EU-FBA') AS fba_stock
  FROM "ChannelListing" cl JOIN "Product" p ON p.id=cl."productId"
  WHERE cl.channel='AMAZON'
    AND EXISTS (SELECT 1 FROM "StockLevel" sl JOIN "StockLocation" loc ON loc.id=sl."locationId"
                WHERE sl."productId"=cl."productId" AND loc.code='AMAZON-EU-FBA' AND sl.quantity>0)
  ORDER BY p.sku, cl.marketplace`)).rows
await c.end()
const bySku = {}
for (const r of rows) (bySku[r.sku] ??= { markets: [], fba: r.fba_stock }).markets.push(r.mkt)
console.log(`Recovery worklist — ${rows.length} listings across ${Object.keys(bySku).length} SKUs (FBA stock present):\n`)
for (const [sku, v] of Object.entries(bySku)) console.log(`  ${sku.padEnd(30)} fbaStock=${String(v.fba).padStart(3)}  markets: ${v.markets.join(', ')}`)
