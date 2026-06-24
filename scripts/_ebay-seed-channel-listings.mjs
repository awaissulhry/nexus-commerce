/**
 * EA-2: Seed DRAFT eBay ChannelListing rows for every active parent product
 * that has no eBay entry. This unblocks the flat-file push and eBay cockpit
 * for products that were never onboarded on eBay.
 *
 * Safe to re-run: uses createMany with skipDuplicates.
 *
 * Usage: node scripts/_ebay-seed-channel-listings.mjs [--marketplace IT]
 * Default marketplace: IT (Xavia's primary market).
 */
import dotenv from 'dotenv'
import path from 'path'
import { fileURLToPath } from 'url'
import pg from 'pg'

const here = path.dirname(fileURLToPath(import.meta.url))
dotenv.config({ path: path.join(here, '..', '.env') })

const marketplace = process.argv.find((a, i) => process.argv[i - 1] === '--marketplace') ?? 'IT'
const channelMarket = `EBAY_${marketplace}`

const url = process.env.DATABASE_URL?.replace('-pooler', '')
if (!url) { console.error('DATABASE_URL not set'); process.exit(1) }

const c = new pg.Client({ connectionString: url })
await c.connect()

// Find parent products that have NO eBay ChannelListing in this marketplace.
const { rows: missing } = await c.query(`
  SELECT p.id, p.sku, p.name
  FROM "Product" p
  WHERE p."isParent" = true
    AND p."deletedAt" IS NULL
    AND NOT EXISTS (
      SELECT 1 FROM "ChannelListing" cl
      WHERE cl."productId" = p.id
        AND cl.channel = 'EBAY'
        AND cl.region = $1
    )
  ORDER BY p.sku
`, [marketplace])

console.log(`Parent products missing eBay ${marketplace} ChannelListing: ${missing.length}`)
if (missing.length === 0) {
  console.log('Nothing to seed.')
  await c.end()
  process.exit(0)
}

missing.forEach(r => console.log(` • ${r.sku} — ${r.name.slice(0, 60)}`))

// Seed a DRAFT ChannelListing for each missing parent.
// All fields that have Prisma defaults are omitted; Postgres uses them.
const now = new Date().toISOString()
let inserted = 0
for (const p of missing) {
  const res = await c.query(`
    INSERT INTO "ChannelListing"
      (id, "productId", channel, "channelMarket", region, marketplace,
       "listingStatus", "isPublished", "offerActive", "stockBuffer",
       "syncFromMaster", "syncLocked", "followMasterTitle",
       "followMasterDescription", "followMasterPrice",
       "followMasterQuantity", "followMasterImages",
       "followMasterBulletPoints", "overrideData",
       "masterBulletPoints", "bulletPointsOverride", "validationErrors",
       version, "createdAt", "updatedAt")
    VALUES (
      gen_random_uuid()::text, $1, 'EBAY', $2, $3, $3,
      'DRAFT', true, true, 0,
      false, false, true,
      true, true,
      true, true,
      true, '{}',
      '{}', '{}', '{}',
      1, $4, $4
    )
    ON CONFLICT ("productId", channel, marketplace) DO NOTHING
  `, [p.id, channelMarket, marketplace, now])
  if (res.rowCount > 0) inserted++
}

console.log(`\nInserted ${inserted} DRAFT eBay ${marketplace} ChannelListings.`)
await c.end()
