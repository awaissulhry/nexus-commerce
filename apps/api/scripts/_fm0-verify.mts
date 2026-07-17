/**
 * Phase 0 live verification (prod DB, net-zero, no marketplace push):
 *  - pin then follow an FBM listing → correct write shape each way
 *  - an FBA listing is SKIPPED (untouched)
 *  - StockLevel + Product.totalStock BYTE-UNCHANGED throughout (Invariant A)
 * Cleanup: cancel every queue row we create + restore the listing exactly.
 */
import prisma from '/Users/awais/nexus-commerce/apps/api/src/db.js'
import { setFollowMasterQuantity } from '/Users/awais/nexus-commerce/apps/api/src/services/follow-master.service.js'

let fails = 0
const ok = (label: string, cond: boolean, detail?: unknown) => {
  console.log(`${cond ? '✅' : '❌'} ${label}${detail !== undefined ? ' — ' + JSON.stringify(detail).slice(0, 160) : ''}`)
  if (!cond) fails++
}

async function poolSnapshot(productId: string) {
  const sls = await prisma.stockLevel.findMany({ where: { productId }, select: { id: true, quantity: true, available: true } })
  const p = await prisma.product.findUnique({ where: { id: productId }, select: { totalStock: true } })
  return JSON.stringify({ totalStock: p?.totalStock, sls: sls.sort((a, b) => a.id.localeCompare(b.id)) })
}

// ── Pick an FBM eBay listing (eBay is always FBM) ───────────────────────
const fbm = await prisma.channelListing.findFirst({
  where: { channel: 'EBAY', listingStatus: { not: 'ENDED' } },
  select: { id: true, productId: true, marketplace: true, quantity: true, quantityOverride: true, followMasterQuantity: true, product: { select: { sku: true } } },
})
if (!fbm) { console.log('no eBay listing to test'); process.exit(1) }
const original = { quantity: fbm.quantity, quantityOverride: fbm.quantityOverride, followMasterQuantity: fbm.followMasterQuantity }
console.log(`FBM test listing: ${fbm.product?.sku} eBay/${fbm.marketplace} | before=${JSON.stringify(original)}`)
const poolBefore = await poolSnapshot(fbm.productId)

// ── PIN ──
const pinRes = await setFollowMasterQuantity({ productIds: [fbm.productId], channel: 'EBAY', markets: [fbm.marketplace], follow: false, actor: 'fm0-verify' })
const afterPin = await prisma.channelListing.findUnique({ where: { id: fbm.id }, select: { quantity: true, quantityOverride: true, followMasterQuantity: true } })
ok('PIN: followMasterQuantity=false', afterPin?.followMasterQuantity === false)
ok('PIN: quantity === quantityOverride (coherent, all columns)', afterPin?.quantity === afterPin?.quantityOverride, afterPin)
ok('PIN: pool (StockLevel + totalStock) UNCHANGED', (await poolSnapshot(fbm.productId)) === poolBefore)
ok('PIN: reported action PIN', pinRes.results.find((r) => r.listingId === fbm.id)?.action === 'PIN', pinRes.results[0])

// ── FOLLOW ──
const folRes = await setFollowMasterQuantity({ productIds: [fbm.productId], channel: 'EBAY', markets: [fbm.marketplace], follow: true, actor: 'fm0-verify' })
const afterFol = await prisma.channelListing.findUnique({ where: { id: fbm.id }, select: { quantityOverride: true, followMasterQuantity: true } })
ok('FOLLOW: followMasterQuantity=true', afterFol?.followMasterQuantity === true)
ok('FOLLOW: quantityOverride cleared to null', afterFol?.quantityOverride === null, afterFol)
ok('FOLLOW: pool UNCHANGED', (await poolSnapshot(fbm.productId)) === poolBefore)
void folRes

// ── FBA skip ──
const fbaListing = await prisma.channelListing.findFirst({
  where: { channel: 'AMAZON', listingStatus: { not: 'ENDED' }, OR: [{ fulfillmentMethod: 'FBA' }, { product: { fulfillmentMethod: 'FBA' } }] },
  select: { id: true, productId: true, marketplace: true, quantity: true, quantityOverride: true, followMasterQuantity: true, product: { select: { sku: true } } },
})
if (fbaListing) {
  const fbaBefore = { quantity: fbaListing.quantity, quantityOverride: fbaListing.quantityOverride, followMasterQuantity: fbaListing.followMasterQuantity }
  const fbaPoolBefore = await poolSnapshot(fbaListing.productId)
  const fbaRes = await setFollowMasterQuantity({ productIds: [fbaListing.productId], channel: 'AMAZON', markets: [fbaListing.marketplace], follow: false, actor: 'fm0-verify' })
  const fbaAfter = await prisma.channelListing.findUnique({ where: { id: fbaListing.id }, select: { quantity: true, quantityOverride: true, followMasterQuantity: true } })
  ok('FBA: reported SKIPPED_FBA', fbaRes.results.some((r) => r.listingId === fbaListing.id && r.action === 'SKIPPED_FBA'), fbaRes.results.find((r) => r.listingId === fbaListing.id))
  ok('FBA: listing quantity fields BYTE-UNCHANGED', JSON.stringify(fbaAfter) === JSON.stringify(fbaBefore), { before: fbaBefore, after: fbaAfter })
  ok('FBA: pool UNCHANGED', (await poolSnapshot(fbaListing.productId)) === fbaPoolBefore)
} else {
  console.log('ℹ️  no FBA Amazon listing found — FBA-skip path untested against prod data')
}

// ── CLEANUP: cancel queue rows we created + restore the FBM listing exactly ──
const cancelled = await prisma.outboundSyncQueue.updateMany({
  where: { channelListingId: fbm.id, syncStatus: 'PENDING', syncType: 'QUANTITY_UPDATE', payload: { path: ['source'], equals: 'FOLLOW_MASTER' } },
  data: { syncStatus: 'CANCELLED' },
})
await prisma.channelListing.update({ where: { id: fbm.id }, data: { ...original } })
const restored = await prisma.channelListing.findUnique({ where: { id: fbm.id }, select: { quantity: true, quantityOverride: true, followMasterQuantity: true } })
ok('CLEANUP: FBM listing restored to original', JSON.stringify(restored) === JSON.stringify(original), { restored, original })
console.log(`CLEANUP: cancelled ${cancelled.count} FOLLOW_MASTER queue row(s) (no marketplace push)`)

console.log(fails === 0 ? '\n🎉 Phase 0 verify: ALL PASS' : `\n💥 Phase 0 verify: ${fails} FAIL`)
await prisma.$disconnect()
process.exit(fails === 0 ? 0 : 1)
