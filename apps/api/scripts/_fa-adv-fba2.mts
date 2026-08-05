const { default: prisma } = await import('../src/db.js')
const listings = await prisma.channelListing.findMany({
  where: { isPublished: true, listingStatus: { notIn: ['ENDED','REMOVED'] }, channel: 'EBAY', fulfillmentMethod: 'FBM',
    product: { fulfillmentMethod: 'FBA' } },
  select: { id: true, productId: true, product: { select: { sku: true } } },
})
console.log('ebay FBM on FBA product:', listings.length)
const ids = listings.map(l=>l.id)
const q = await prisma.outboundSyncQueue.groupBy({ by: ['status','syncType'], where: { channelListingId: { in: ids } }, _count: true })
console.log(q)
const recent = await prisma.outboundSyncQueue.findMany({ where: { channelListingId: { in: ids }, syncType: 'QUANTITY_UPDATE' }, orderBy: { createdAt: 'desc' }, take: 5,
  select: { createdAt: true, status: true, quantity: true, reason: true, channelListingId: true } })
console.log(recent)
await prisma.$disconnect()
