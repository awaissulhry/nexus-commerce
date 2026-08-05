const { default: prisma } = await import('../src/db.js')
const MERCHANT = new Set(['EBAY', 'SHOPIFY', 'WOOCOMMERCE', 'ETSY'])
const hidden = await prisma.channelListing.findMany({
  where: { OR: [{ isPublished: false }, { listingStatus: { in: ['ENDED', 'REMOVED'] } }] },
  select: { channel: true, marketplace: true, isPublished: true, listingStatus: true, followMasterQuantity: true, syncPaused: true, quantity: true, fulfillmentMethod: true, externalListingId: true, productId: true, product: { select: { sku: true, fulfillmentMethod: true } } },
})
const pids = [...new Set(hidden.map((h) => h.productId))]
const fba = await prisma.stockLevel.groupBy({ by: ['productId'], where: { productId: { in: pids }, location: { type: 'AMAZON_FBA' } }, _sum: { quantity: true } })
const fbaOf = new Map(fba.map((f) => [f.productId, f._sum.quantity ?? 0]))
const engFbm = hidden.filter((h) => {
  const lfm = h.fulfillmentMethod
  if (lfm === 'FBA') return false
  if (lfm === 'FBM') return !(h.channel === 'AMAZON' && (h.product?.fulfillmentMethod === 'FBA' || (fbaOf.get(h.productId) ?? 0) > 0))
  if (MERCHANT.has(h.channel)) return true
  return !((fbaOf.get(h.productId) ?? 0) > 0 || h.product?.fulfillmentMethod === 'FBA')
})
console.log('hidden-from-SC listings:', hidden.length, '| engine treats as FBM (cascade-eligible):', engFbm.length)
console.log(JSON.stringify(engFbm.map((h) => ({ sku: h.product?.sku, ch: h.channel, mk: h.marketplace, pub: h.isPublished, st: h.listingStatus, follow: h.followMasterQuantity, paused: h.syncPaused, qty: h.quantity, item: h.externalListingId })), null, 1))
await prisma.$disconnect()
