#!/usr/bin/env node
// Commit 0 — reconcile ChannelListing rows that follow master but have
// drifted price or quantity. The audit found 2 such rows in production:
// AIRMESH-JACKET-YELLOW-MEN on AMAZON IT + DE.
//
// On inspection the drift went the WRONG way:
//   listing_price=€42.50/€44.95  vs  master_basePrice=€0
//   listing_qty=50/30             vs  master_totalStock=0
//
// The master is broken, not the listings — Product.basePrice and
// Product.totalStock got zeroed out by some historic write (likely a
// soft-delete pass or a malformed import) while the live Amazon
// listings still hold real prices/quantities and are still serving
// orders to buyers.
//
// Snapping listing → master would set Amazon prices to €0 (free) and
// quantity to 0. Catastrophic. So we go the other direction: flip
// followMasterPrice + followMasterQuantity to FALSE on the drifted
// rows so the listings explicitly own their own values until someone
// restores Product.basePrice/totalStock manually.
//
// This is fully reversible — once a human restores the correct master
// values, set followMaster*=true again and the cascade resumes
// normally. The audit's drift count drops to zero either way.
//
// Usage (read-only by default — pass --apply to write):
//   DATABASE_URL=... node scripts/reconcile-master-drift.mjs
//   DATABASE_URL=... node scripts/reconcile-master-drift.mjs --apply

import { PrismaClient } from '@prisma/client'
import { config } from 'dotenv'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
config({ path: join(here, '..', 'packages', 'database', '.env') })

const apply = process.argv.includes('--apply')
const prisma = new PrismaClient()

console.log(`Mode: ${apply ? 'APPLY (will write)' : 'DRY RUN (no writes)'}\n`)

// Find every row whose follow flag is on but the value diverges from
// master. We treat price-drift and quantity-drift as separate sets
// because a row may drift on only one of the two.
const priceDrift = await prisma.$queryRawUnsafe(`
  SELECT cl.id AS listing_id, cl."productId" AS product_id, p.sku, cl.channel,
         cl.marketplace, cl.price AS listing_price, p."basePrice" AS master_price
  FROM "ChannelListing" cl JOIN "Product" p ON p.id = cl."productId"
  WHERE cl."followMasterPrice" = true AND cl.price != p."basePrice"
  ORDER BY cl.id
`)

console.log(`━━━ Price drift (followMasterPrice=true, price != basePrice) ━━━`)
console.log(`Found ${priceDrift.length} row(s)\n`)
for (const row of priceDrift) {
  console.log(
    `  listing=${row.listing_id} sku=${row.sku} ${row.channel}/${row.marketplace}` +
      `  listing_price=${row.listing_price}  master_price=${row.master_price}`,
  )
}

const qtyDrift = await prisma.$queryRawUnsafe(`
  SELECT cl.id AS listing_id, cl."productId" AS product_id, p.sku, cl.channel,
         cl.marketplace, cl.quantity AS listing_qty,
         p."totalStock" AS total_stock,
         COALESCE(cl."stockBuffer", 0) AS buffer,
         GREATEST(0, p."totalStock" - COALESCE(cl."stockBuffer", 0)) AS expected_qty
  FROM "ChannelListing" cl JOIN "Product" p ON p.id = cl."productId"
  WHERE cl."followMasterQuantity" = true
    AND cl.quantity != GREATEST(0, p."totalStock" - COALESCE(cl."stockBuffer", 0))
  ORDER BY cl.id
`)

console.log(`\n━━━ Quantity drift (followMasterQuantity=true) ━━━`)
console.log(`Found ${qtyDrift.length} row(s)\n`)
for (const row of qtyDrift) {
  console.log(
    `  listing=${row.listing_id} sku=${row.sku} ${row.channel}/${row.marketplace}` +
      `  listing_qty=${row.listing_qty}  expected=${row.expected_qty}` +
      `  (totalStock=${row.total_stock}, buffer=${row.buffer})`,
  )
}

if (!apply) {
  console.log(
    `\nDry run complete. Re-run with --apply to flip followMaster* to false on the drifted rows.`,
  )
  await prisma.$disconnect()
  process.exit(0)
}

// Apply: flip followMaster* to false. We DO NOT touch the listing's
// price or quantity — the live Amazon values stay exactly as they
// are. We DO NOT enqueue an outbound sync — nothing about the
// marketplace's view changes.
//
// Audit row records the flag flip so this is visible in history.
console.log(`\n━━━ Applying: flip followMaster* to false on drifted rows ━━━\n`)

let priceFixed = 0
for (const row of priceDrift) {
  await prisma.$transaction(async (tx) => {
    await tx.channelListing.update({
      where: { id: row.listing_id },
      data: { followMasterPrice: false, version: { increment: 1 } },
    })
    await tx.auditLog.create({
      data: {
        entityType: 'ChannelListing',
        entityId: row.listing_id,
        action: 'update',
        userId: null,
        before: { followMasterPrice: true },
        after: { followMasterPrice: false },
        metadata: {
          field: 'followMasterPrice',
          reason: 'master-drift-reconcile-unfollow',
          source: 'scripts/reconcile-master-drift.mjs',
          listing_price: String(row.listing_price),
          master_price: String(row.master_price),
          note: 'master was broken (basePrice=0); flipped follow flag off so live listing price is preserved',
        },
        createdAt: new Date(),
      },
    })
  })
  priceFixed++
  console.log(
    `  ✓ unfollowed price: ${row.listing_id}  listing kept at ${row.listing_price}`,
  )
}

let qtyFixed = 0
for (const row of qtyDrift) {
  await prisma.$transaction(async (tx) => {
    await tx.channelListing.update({
      where: { id: row.listing_id },
      data: { followMasterQuantity: false, version: { increment: 1 } },
    })
    await tx.auditLog.create({
      data: {
        entityType: 'ChannelListing',
        entityId: row.listing_id,
        action: 'update',
        userId: null,
        before: { followMasterQuantity: true },
        after: { followMasterQuantity: false },
        metadata: {
          field: 'followMasterQuantity',
          reason: 'master-drift-reconcile-unfollow',
          source: 'scripts/reconcile-master-drift.mjs',
          listing_qty: row.listing_qty,
          master_total_stock: row.total_stock,
          buffer: row.buffer,
          note: 'master was broken (totalStock=0); flipped follow flag off so live listing quantity is preserved',
        },
        createdAt: new Date(),
      },
    })
  })
  qtyFixed++
  console.log(
    `  ✓ unfollowed qty: ${row.listing_id}  listing kept at ${row.listing_qty}`,
  )
}

await prisma.$disconnect()
console.log(`\nDone. price_unfollowed=${priceFixed} qty_unfollowed=${qtyFixed}`)
console.log(
  `\nNext step: a human needs to restore Product.basePrice and Product.totalStock`,
)
console.log(
  `for AIRMESH-JACKET-YELLOW-MEN, then flip followMaster* back to true if desired.`,
)
