// _inv-split-13-fbm-overhang.mjs — Phase 1.2 backfill.
// Correct FBM listings whose published quantity exceeds warehouse AVAILABLE
// (gross→available: the reserved overhang). Mirrors the new pool-aware cascade.
// Only DOWNWARD corrections (oversell), only for products that HAVE a warehouse
// StockLevel ledger (legacy feed-set products with no ledger are left alone).
// DRY RUN by default. Pass --apply to write + enqueue pushes.
import { PrismaClient } from '@prisma/client'
import { config } from 'dotenv'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
config({ path: join(dirname(fileURLToPath(import.meta.url)), '..', '.env') })

const APPLY = process.argv.includes('--apply')
const prisma = new PrismaClient()
const MERCHANT_CHANNELS = new Set(['EBAY', 'SHOPIFY', 'WOOCOMMERCE', 'ETSY'])
const VALID_TARGETS = new Set(['AMAZON', 'EBAY', 'SHOPIFY', 'WOOCOMMERCE'])

const listings = await prisma.channelListing.findMany({
  where: { followMasterQuantity: true, quantity: { not: null } },
  select: {
    id: true, channel: true, marketplace: true, region: true, externalListingId: true,
    quantity: true, stockBuffer: true, fulfillmentMethod: true, productId: true,
    product: {
      select: {
        sku: true, fulfillmentMethod: true,
        stockLevels: { select: { available: true, quantity: true, location: { select: { type: true } } } },
      },
    },
  },
})

const changes = []
for (const cl of listings) {
  const levels = cl.product.stockLevels
  if (!levels.some((s) => s.location?.type === 'WAREHOUSE')) continue // no ledger — skip
  const warehouseAvailable = levels.filter((s) => s.location?.type === 'WAREHOUSE').reduce((a, s) => a + s.available, 0)
  const fbaBucket = levels.filter((s) => s.location?.type === 'AMAZON_FBA').reduce((a, s) => a + s.quantity, 0)
  const method =
    cl.fulfillmentMethod === 'FBA' || cl.fulfillmentMethod === 'FBM' ? cl.fulfillmentMethod
    : MERCHANT_CHANNELS.has(cl.channel) ? 'FBM'
    : (fbaBucket > 0 || cl.product.fulfillmentMethod === 'FBA') ? 'FBA' : 'FBM'
  if (method !== 'FBM') continue
  const newQty = Math.max(0, warehouseAvailable - (cl.stockBuffer ?? 0))
  if (newQty >= cl.quantity) continue // only fix DOWNWARD overhangs (oversell)
  changes.push({ cl, newQty, warehouseAvailable })
}

console.log(`\n${APPLY ? 'APPLY' : 'DRY-RUN'} — Phase 1.2 FBM overhang correction (gross -> available)`)
console.log(`FBM listings over warehouse-available: ${changes.length}\n`)
for (const { cl, newQty, warehouseAvailable } of changes) {
  console.log(`• ${cl.product.sku} ${cl.channel}/${cl.marketplace}: qty ${cl.quantity} -> ${newQty}  (wh available ${warehouseAvailable}, buffer ${cl.stockBuffer ?? 0})`)
}

if (!APPLY) {
  console.log('\nDry run only. Re-run with --apply to write + enqueue.')
  await prisma.$disconnect()
  process.exit(0)
}

let enq = 0
for (const { cl, newQty } of changes) {
  await prisma.$transaction(async (tx) => {
    await tx.channelListing.update({
      where: { id: cl.id },
      data: { quantity: newQty, lastSyncStatus: 'PENDING', lastSyncedAt: null, version: { increment: 1 } },
    })
    if (VALID_TARGETS.has(cl.channel)) {
      await tx.outboundSyncQueue.create({
        data: {
          productId: cl.productId, channelListingId: cl.id, targetChannel: cl.channel, targetRegion: cl.region,
          syncStatus: 'PENDING', syncType: 'QUANTITY_UPDATE', holdUntil: new Date(),
          externalListingId: cl.externalListingId, maxRetries: 3,
          payload: {
            source: 'INV_SPLIT_FBM_AVAIL', productId: cl.productId, channel: cl.channel,
            marketplace: cl.marketplace, quantity: newQty, oldQuantity: cl.quantity, reason: 'FBM_AVAILABLE_FIX',
          },
        },
      })
      enq++
    }
  })
}
console.log(`\nApplied. Listings corrected: ${changes.length}, pushes enqueued: ${enq}`)
await prisma.$disconnect()
