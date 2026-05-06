#!/usr/bin/env node
/**
 * Phase 13f — backfill ChannelListing.masterPrice + masterQuantity from
 * the linked Product's basePrice + totalStock so the drift baseline is
 * correct on day one of the master-data cascade (TECH_DEBT #42).
 *
 * Why we need it:
 *   MasterPriceService and applyStockMovement both treat masterPrice /
 *   masterQuantity as "what the listing thinks the master value is."
 *   Without a baseline snapshot, a followMasterPrice=false listing
 *   would show drift forever (price ≠ masterPrice → masterPrice null
 *   means "we don't know what the master was last time we synced").
 *   The first edit through the new services would populate the snapshot
 *   and *that* would become the baseline — but everything before that
 *   first edit reads as "stale snapshot, untrustworthy."
 *
 * What it does:
 *   Two idempotent UPDATEs:
 *     1. masterPrice  = Product.basePrice    where masterPrice IS NULL
 *                                            AND Product.basePrice > 0
 *     2. masterQuantity = Product.totalStock where masterQuantity IS NULL
 *
 * Why the basePrice > 0 filter on masterPrice:
 *   Several listings exist for products whose basePrice is still 0
 *   (the master hasn't been priced yet — the listing carries a per-
 *   marketplace override). Snapshotting masterPrice=0 would tell the
 *   drift detector "master is intentionally zero, listing.price is
 *   wildly out of sync" forever. Better to leave masterPrice NULL
 *   until the master gets a real price; the next edit through
 *   MasterPriceService populates it correctly.
 *
 * Why no cascade:
 *   This is a baseline snapshot, not a price/quantity recompute. Cascade
 *   logic (computeListingPrice etc.) runs on real edits via the
 *   services. Running cascade here would generate phantom
 *   OutboundSyncQueue rows for listings whose computed price already
 *   matches what's on the marketplace — pointless work + a wave of
 *   spurious marketplace pushes.
 *
 * Idempotent — safe to run multiple times. The "IS NULL" filters make
 * subsequent runs no-ops on rows the prior run already touched.
 *
 * Usage:
 *   node scripts/backfill-channel-listing-master-snapshot.mjs           — dry run, prints counts
 *   node scripts/backfill-channel-listing-master-snapshot.mjs --apply   — actually run the UPDATEs
 */

import dotenv from 'dotenv'
import { fileURLToPath } from 'url'
import path from 'path'
import pg from 'pg'

const here = path.dirname(fileURLToPath(import.meta.url))
dotenv.config({ path: path.join(here, '..', '.env') })
dotenv.config({ path: path.join(here, '..', 'packages', 'database', '.env') })

const url = process.env.DATABASE_URL
if (!url) {
  console.error('DATABASE_URL missing — set it in .env at repo root')
  process.exit(1)
}

const apply = process.argv.includes('--apply')

const client = new pg.Client({ connectionString: url })
await client.connect()

console.log(`Mode: ${apply ? 'APPLY (writes will commit)' : 'DRY RUN (no writes)'}`)

// Eligible counts BEFORE the backfill — for a clean before/after report.
const priceCandidates = await client.query(`
  SELECT count(*)::int AS n
  FROM "ChannelListing" cl
  JOIN "Product" p ON p.id = cl."productId"
  WHERE cl."masterPrice" IS NULL AND p."basePrice" > 0
`)
const quantityCandidates = await client.query(`
  SELECT count(*)::int AS n
  FROM "ChannelListing" cl
  JOIN "Product" p ON p.id = cl."productId"
  WHERE cl."masterQuantity" IS NULL
`)
const skippedZeroPrice = await client.query(`
  SELECT count(*)::int AS n
  FROM "ChannelListing" cl
  JOIN "Product" p ON p.id = cl."productId"
  WHERE cl."masterPrice" IS NULL AND (p."basePrice" IS NULL OR p."basePrice" = 0)
`)

console.log('\nEligible rows:')
console.log(`  masterPrice    backfill candidates : ${priceCandidates.rows[0].n}`)
console.log(`  masterPrice    skipped (basePrice=0): ${skippedZeroPrice.rows[0].n}`)
console.log(`  masterQuantity backfill candidates : ${quantityCandidates.rows[0].n}`)

if (!apply) {
  console.log('\nDry run complete. Re-run with --apply to commit.')
  await client.end()
  process.exit(0)
}

await client.query('BEGIN')
try {
  const priceResult = await client.query(`
    UPDATE "ChannelListing" cl
    SET "masterPrice" = p."basePrice"
    FROM "Product" p
    WHERE cl."productId" = p.id
      AND cl."masterPrice" IS NULL
      AND p."basePrice" > 0
  `)
  const quantityResult = await client.query(`
    UPDATE "ChannelListing" cl
    SET "masterQuantity" = p."totalStock"
    FROM "Product" p
    WHERE cl."productId" = p.id
      AND cl."masterQuantity" IS NULL
  `)

  // Audit trail. AuditLog metadata records the script name + ISO timestamp
  // so a future query can find every row touched by this backfill.
  await client.query(
    `
    INSERT INTO "AuditLog" ("id", "entityType", "entityId", action, before, after, metadata, "createdAt")
    VALUES (
      gen_random_uuid()::text,
      'ChannelListing',
      'BULK_BACKFILL',
      'update',
      NULL,
      $1::jsonb,
      $2::jsonb,
      now()
    )
  `,
    [
      JSON.stringify({
        masterPriceBackfilled: priceResult.rowCount,
        masterQuantityBackfilled: quantityResult.rowCount,
      }),
      JSON.stringify({
        script: 'backfill-channel-listing-master-snapshot.mjs',
        phase: '13f',
        ranAt: new Date().toISOString(),
      }),
    ],
  )

  await client.query('COMMIT')
  console.log('\n✓ Backfill committed:')
  console.log(`  masterPrice    rows updated: ${priceResult.rowCount}`)
  console.log(`  masterQuantity rows updated: ${quantityResult.rowCount}`)
  console.log('  AuditLog row written tagged entityId=BULK_BACKFILL')
} catch (err) {
  await client.query('ROLLBACK')
  console.error('\n✗ Backfill failed, rolled back:', err)
  process.exit(1)
} finally {
  await client.end()
}
