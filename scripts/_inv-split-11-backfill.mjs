// _inv-split-11-backfill.mjs — Phase 1.1 backfill.
// Recompute Product.totalStock as WAREHOUSE-only (the FBM / own-shippable
// merchant pool), then cascade the corrected quantity to FBM ChannelListings
// (eBay/Shopify/Woo + Amazon-FBM), enqueuing OutboundSyncQueue QUANTITY_UPDATE
// so the sync worker pushes the (lower, oversell-safe) correction live.
//
// Amazon-FBA listings: their cached quantity is corrected for DB consistency
// but NO push is enqueued (Amazon manages FBA qty; isFbaListing() would skip it
// anyway — avoids queue churn).
//
// DRY RUN by default. Pass --apply to write.
import { PrismaClient } from '@prisma/client'
import { config } from 'dotenv'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
config({ path: join(dirname(fileURLToPath(import.meta.url)), '..', '.env') })

const APPLY = process.argv.includes('--apply')
const prisma = new PrismaClient()

// FBM channels whose published quantity follows the warehouse (merchant) pool.
const FBM_CHANNELS = new Set(['EBAY', 'SHOPIFY', 'WOOCOMMERCE', 'ETSY'])
// OutboundSyncQueue.targetChannel accepted values (mirrors cascade validTargets).
const VALID_TARGETS = new Set(['AMAZON', 'EBAY', 'SHOPIFY', 'WOOCOMMERCE'])

const products = await prisma.product.findMany({
  select: {
    id: true, sku: true, totalStock: true,
    stockLevels: { select: { quantity: true, location: { select: { type: true } } } },
    channelListings: {
      select: {
        id: true, channel: true, marketplace: true, region: true, externalListingId: true,
        quantity: true, stockBuffer: true, followMasterQuantity: true, fulfillmentMethod: true,
      },
    },
  },
})

const changes = []
for (const p of products) {
  const whTotal = p.stockLevels
    .filter((s) => s.location?.type === 'WAREHOUSE')
    .reduce((s, sl) => s + sl.quantity, 0)
  const fbaTotal = p.stockLevels
    .filter((s) => s.location?.type === 'AMAZON_FBA')
    .reduce((s, sl) => s + sl.quantity, 0)
  // Scope: ONLY the FBA bleed — products where AMAZON_FBA stock is being
  // summed into totalStock (fba>0 AND totalStock exceeds the warehouse pool).
  // Products with totalStock>0 but NO StockLevel rows (legacy feed-set
  // totalStock; warehouse=0 & fba=0) are a SEPARATE data-integrity issue,
  // NOT the FBA bleed — excluded here so we never wrongly zero live listings.
  if (!(fbaTotal > 0 && p.totalStock > whTotal)) continue
  const listingChanges = []
  for (const cl of p.channelListings) {
    if (!cl.followMasterQuantity) continue
    const newQty = Math.max(0, whTotal - (cl.stockBuffer ?? 0))
    if (newQty === cl.quantity) continue
    const enqueue =
      VALID_TARGETS.has(cl.channel) &&
      (FBM_CHANNELS.has(cl.channel) || (cl.channel === 'AMAZON' && cl.fulfillmentMethod === 'FBM'))
    listingChanges.push({ cl, newQty, enqueue })
  }
  changes.push({ p, whTotal, fbaTotal, listingChanges })
}

console.log(`\n${APPLY ? 'APPLY' : 'DRY-RUN'} — Phase 1.1 totalStock warehouse-only backfill`)
console.log(`Products scanned: ${products.length}`)
console.log(`Products drifted (totalStock != warehouse-only): ${changes.length}\n`)
for (const { p, whTotal, fbaTotal, listingChanges } of changes) {
  console.log(`• ${p.sku}: totalStock ${p.totalStock} -> ${whTotal}   (warehouse ${whTotal} + FBA ${fbaTotal} was being summed)`)
  for (const { cl, newQty, enqueue } of listingChanges) {
    console.log(`    ${cl.channel}/${cl.marketplace} qty ${cl.quantity} -> ${newQty}  fm=${cl.fulfillmentMethod ?? '(null)'}  ${enqueue ? '[enqueue push]' : '[fix DB only, no push]'}`)
  }
}

if (!APPLY) {
  console.log(`\nDry run only. Re-run with --apply to write + enqueue corrections.`)
  await prisma.$disconnect()
  process.exit(0)
}

let listingFixCount = 0, enqueueCount = 0
for (const { p, whTotal, listingChanges } of changes) {
  await prisma.$transaction(async (tx) => {
    await tx.product.update({ where: { id: p.id }, data: { totalStock: whTotal } })
    for (const { cl, newQty, enqueue } of listingChanges) {
      await tx.channelListing.update({
        where: { id: cl.id },
        data: {
          quantity: newQty,
          masterQuantity: whTotal,
          lastSyncStatus: 'PENDING',
          lastSyncedAt: null,
          version: { increment: 1 },
        },
      })
      listingFixCount++
      if (enqueue) {
        await tx.outboundSyncQueue.create({
          data: {
            productId: p.id,
            channelListingId: cl.id,
            targetChannel: cl.channel,
            targetRegion: cl.region,
            syncStatus: 'PENDING',
            syncType: 'QUANTITY_UPDATE',
            holdUntil: new Date(),
            externalListingId: cl.externalListingId,
            maxRetries: 3,
            payload: {
              source: 'INV_SPLIT_BACKFILL',
              productId: p.id,
              channel: cl.channel,
              marketplace: cl.marketplace,
              quantity: newQty,
              oldQuantity: cl.quantity,
              masterQuantity: whTotal,
              stockBuffer: cl.stockBuffer ?? 0,
              reason: 'SPLIT_INVENTORY_FIX',
            },
          },
        })
        enqueueCount++
      }
    }
  })
}
console.log(`\nApplied. Products corrected: ${changes.length}, listings corrected: ${listingFixCount}, pushes enqueued: ${enqueueCount}`)
await prisma.$disconnect()
