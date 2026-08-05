const { default: prisma } = await import('../src/db.js')
const listings = await prisma.channelListing.findMany({
  where: { isPublished: true, listingStatus: { notIn: ['ENDED','REMOVED'] }, channel: 'EBAY', fulfillmentMethod: 'FBM',
    product: { fulfillmentMethod: 'FBA' } },
  select: { id: true, quantity: true, externalListingId: true, product: { select: { sku: true } } },
})
const ids = listings.map(l=>l.id)
const q = await prisma.outboundSyncQueue.groupBy({ by: ['syncStatus','syncType'], where: { channelListingId: { in: ids } }, _count: { _all: true } })
console.log('queue by status/type', JSON.stringify(q))
const recent = await prisma.outboundSyncQueue.findMany({ where: { channelListingId: { in: ids }, syncType: 'QUANTITY_UPDATE' }, orderBy: { createdAt: 'desc' }, take: 6,
  select: { createdAt: true, syncStatus: true, payload: true, channelListingId: true, targetChannel: true } })
console.log(JSON.stringify(recent, null, 1))
await prisma.$disconnect()
