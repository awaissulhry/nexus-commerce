#!/usr/bin/env node
// Fix 4 — APPLY the FBA marker backfill. WRITES to prod.
//   1. Snapshots the affected rows + old values to a rollback JSON (reversible).
//   2. Runs both UPDATEs in ONE transaction.
// Approved by user 2026-06-18 after the read-only preview (64 ChannelListing + 2 Product).
import dotenv from 'dotenv'; import path from 'path'; import { fileURLToPath } from 'url'; import { writeFileSync } from 'fs'; import pg from 'pg'
const here = path.dirname(fileURLToPath(import.meta.url)); dotenv.config({ path: path.join(here, '..', '.env') })
const url = process.env.DATABASE_URL?.replace('-pooler', ''); if (!url) { console.error('no DATABASE_URL'); process.exit(1) }
const c = new pg.Client({ connectionString: url }); await c.connect()

const SET1_WHERE = `cl.channel='AMAZON'
  AND (cl."fulfillmentMethod" IS NULL OR cl."fulfillmentMethod"::text <> 'FBA')
  AND ( EXISTS (SELECT 1 FROM "StockLevel" sl JOIN "StockLocation" loc ON loc.id=sl."locationId"
               WHERE sl."productId"=cl."productId" AND loc.code='AMAZON-EU-FBA' AND sl.quantity>0)
     OR EXISTS (SELECT 1 FROM "Offer" o WHERE o."channelListingId"=cl.id
               AND o."fulfillmentMethod"::text='FBA' AND o."isActive") )`
const SET2_WHERE = `(p."fulfillmentMethod" IS NULL OR p."fulfillmentMethod"::text <> 'FBA')
  AND EXISTS (SELECT 1 FROM "StockLevel" sl JOIN "StockLocation" loc ON loc.id=sl."locationId"
              WHERE sl."productId"=p.id AND loc.code='AMAZON-EU-FBA' AND sl.quantity>0)`

// 1. Snapshot before-state for rollback.
const cl1 = (await c.query(`SELECT cl.id, cl."fulfillmentMethod"::text fm FROM "ChannelListing" cl WHERE ${SET1_WHERE}`)).rows
const pr2 = (await c.query(`SELECT p.id, p."fulfillmentMethod"::text fm FROM "Product" p WHERE ${SET2_WHERE}`)).rows
const stamp = new Date().toISOString().replace(/[:.]/g, '-')
const rollbackPath = path.join(here, `_fba-backfill-rollback-${stamp}.json`)
writeFileSync(rollbackPath, JSON.stringify({ capturedAt: new Date().toISOString(), channelListing: cl1, product: pr2 }, null, 2))
console.log(`Rollback snapshot written: ${rollbackPath}`)
console.log(`  ChannelListing rows captured: ${cl1.length}   Product rows captured: ${pr2.length}`)

// 2. Apply in a single transaction.
try {
  await c.query('BEGIN')
  const u1 = await c.query(`UPDATE "ChannelListing" cl SET "fulfillmentMethod"='FBA' FROM "Product" p
    WHERE p.id=cl."productId" AND ${SET1_WHERE}`)
  const u2 = await c.query(`UPDATE "Product" p SET "fulfillmentMethod"='FBA' WHERE ${SET2_WHERE}`)
  await c.query('COMMIT')
  console.log(`\n✅ COMMITTED`)
  console.log(`   ChannelListing updated → FBA: ${u1.rowCount}`)
  console.log(`   Product updated → FBA:        ${u2.rowCount}`)
} catch (e) {
  await c.query('ROLLBACK').catch(() => {})
  console.error(`\n❌ ROLLED BACK — ${e.message}`)
  await c.end(); process.exit(1)
}

await c.end()
console.log(`\nTo revert: restore each id in ${path.basename(rollbackPath)} to its captured fulfillmentMethod.`)
console.log('Done.')
