const { default: prisma } = await import('../src/db.js')
const listings = await prisma.channelListing.findMany({
  where: { isPublished: true, listingStatus: { notIn: ['ENDED','REMOVED'] }, channel: 'EBAY', fulfillmentMethod: { not: 'FBA' }, product: { fulfillmentMethod: 'FBA' } },
  select: { id: true, quantity: true, masterQuantity: true, lastSyncStatus: true, lastSyncedAt: true, product: { select: { sku: true } } },
})
console.log('ebay mismatch listings', listings.length)
const ids = listings.map(l => l.id)
const g = await prisma.outboundSyncQueue.groupBy({ by: ['syncStatus'], where: { channelListingId: { in: ids }, syncType: 'QUANTITY_UPDATE' }, _count: { _all: true } })
console.log('queue by syncStatus', JSON.stringify(g))
const latest = await prisma.outboundSyncQueue.findMany({ where: { channelListingId: { in: ids }, syncType: 'QUANTITY_UPDATE' }, orderBy: { createdAt: 'desc' }, take: 4, select: { syncStatus: true, createdAt: true, payload: true, reason: true, channelListingId: true } })
console.log(JSON.stringify(latest, null, 1).slice(0, 2000))
console.log('lastSync sample', listings.slice(0,3).map(l => ({ sku: l.product?.sku, q: l.quantity, mq: l.masterQuantity, st: l.lastSyncStatus, at: l.lastSyncedAt })))
await prisma.$disconnect()
