const { default: prisma } = await import('../src/db.js')

const listings = await prisma.channelListing.findMany({
  where: { isPublished: true, listingStatus: { notIn: ['ENDED', 'REMOVED'] } },
  select: {
    id: true, productId: true, channel: true, marketplace: true, quantity: true,
    fulfillmentMethod: true, syncPaused: true, followMasterQuantity: true,
    externalListingId: true,
    product: { select: { sku: true, fulfillmentMethod: true } },
  },
})

const MERCHANT = new Set(['EBAY', 'SHOPIFY', 'WOOCOMMERCE', 'WOO', 'ETSY'])
const mism = listings.filter((cl) => {
  const scFba =
    cl.fulfillmentMethod === 'FBA' ||
    (cl.fulfillmentMethod == null && cl.product?.fulfillmentMethod === 'FBA') ||
    cl.product?.fulfillmentMethod === 'FBA'
  const engineFba =
    cl.fulfillmentMethod === 'FBA' ? true
      : cl.fulfillmentMethod === 'FBM' ? false
      : MERCHANT.has(cl.channel) ? false
      : cl.product?.fulfillmentMethod === 'FBA'
  return scFba && !engineFba
})

console.log('total published listings', listings.length)
console.log('MISMATCH scFBA & engineFBM:', mism.length)
const byCh: Record<string, number> = {}
for (const m of mism) byCh[`${m.channel}:${m.marketplace}:lfm=${m.fulfillmentMethod}`] = (byCh[`${m.channel}:${m.marketplace}:lfm=${m.fulfillmentMethod}`] ?? 0) + 1
console.log(byCh)
console.log('follow=true count', mism.filter(m => m.followMasterQuantity).length, 'paused', mism.filter(m => m.syncPaused).length)
console.log('sample', mism.slice(0, 5).map(m => ({ id: m.id, sku: m.product?.sku, ch: m.channel, mk: m.marketplace, q: m.quantity, item: m.externalListingId, follow: m.followMasterQuantity })))

const ids = mism.map(m => m.id)
const q = await prisma.outboundSyncQueue.groupBy({
  by: ['status'],
  where: { channelListingId: { in: ids }, syncType: 'QUANTITY_UPDATE' },
  _count: { _all: true },
})
console.log('queue QUANTITY_UPDATE by status', q)
const latest = await prisma.outboundSyncQueue.findMany({
  where: { channelListingId: { in: ids }, syncType: 'QUANTITY_UPDATE', status: 'SUCCESS' },
  orderBy: { updatedAt: 'desc' }, take: 5,
  select: { channelListingId: true, updatedAt: true, payload: true, status: true },
})
console.log('latest success', JSON.stringify(latest, null, 1).slice(0, 1500))
await prisma.$disconnect()
