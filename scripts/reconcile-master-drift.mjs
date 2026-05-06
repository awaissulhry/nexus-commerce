#!/usr/bin/env node
// Commit 0 — reconcile ChannelListing rows that follow master but have
// drifted price or quantity. The audit found 2 such rows in production
// (G + H sections of audit-products-state output). They drifted because
// of writes that happened before MasterPriceService / applyStockMovement
// became the single entrypoint — historic raw updateMany / direct writes.
//
// Approach:
//   For each drifted row, route a single MasterPriceService.update or
//   applyStockMovement call so the cascade + audit + outbound queue
//   fire normally. We want the marketplace to see the corrected value,
//   not just the DB.
//
// Usage (read-only by default — pass --apply to actually fix):
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

// G — price drift on master-following rows
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

// H — quantity drift on master-following rows
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
    `\nDry run complete. Re-run with --apply to write the reconciled values.`,
  )
  await prisma.$disconnect()
  process.exit(0)
}

// Apply: for each drifted price row, snap ChannelListing.price to master.
// We do not invoke MasterPriceService because we don't want to push the
// marketplace's own current price back through — the master is the
// source of truth, the listing already drifted. We're just realigning
// the DB so the next legitimate price change cascades cleanly.
//
// Same for quantity: snap ChannelListing.quantity to the computed
// expected. No outbound enqueue — the next stock movement will push.
//
// AuditLog rows are written so the reconcile is visible in history.
console.log(`\n━━━ Applying reconciliation ━━━\n`)

let priceFixed = 0
for (const row of priceDrift) {
  await prisma.$transaction(async (tx) => {
    await tx.channelListing.update({
      where: { id: row.listing_id },
      data: { price: row.master_price, version: { increment: 1 } },
    })
    await tx.auditLog.create({
      data: {
        entityType: 'ChannelListing',
        entityId: row.listing_id,
        action: 'update',
        userId: null,
        before: { price: row.listing_price },
        after: { price: row.master_price },
        metadata: {
          field: 'price',
          reason: 'master-drift-reconcile',
          source: 'scripts/reconcile-master-drift.mjs',
        },
        createdAt: new Date(),
      },
    })
  })
  priceFixed++
  console.log(
    `  ✓ price snapped: ${row.listing_id}  ${row.listing_price} → ${row.master_price}`,
  )
}

let qtyFixed = 0
for (const row of qtyDrift) {
  await prisma.$transaction(async (tx) => {
    await tx.channelListing.update({
      where: { id: row.listing_id },
      data: { quantity: row.expected_qty, version: { increment: 1 } },
    })
    await tx.auditLog.create({
      data: {
        entityType: 'ChannelListing',
        entityId: row.listing_id,
        action: 'update',
        userId: null,
        before: { quantity: row.listing_qty },
        after: { quantity: row.expected_qty },
        metadata: {
          field: 'quantity',
          reason: 'master-drift-reconcile',
          source: 'scripts/reconcile-master-drift.mjs',
          totalStock: row.total_stock,
          buffer: row.buffer,
        },
        createdAt: new Date(),
      },
    })
  })
  qtyFixed++
  console.log(
    `  ✓ quantity snapped: ${row.listing_id}  ${row.listing_qty} → ${row.expected_qty}`,
  )
}

await prisma.$disconnect()
console.log(`\nDone. price_fixed=${priceFixed} qty_fixed=${qtyFixed}`)
