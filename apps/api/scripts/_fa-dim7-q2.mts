const { default: prisma } = await import('../src/db.js')
const listings = await prisma.channelListing.findMany({
  where: { isPublished: true, listingStatus: { notIn: ['ENDED','REMOVED'] }, channel: 'EBAY', fulfillmentMethod: { not: 'FBA' }, product: { fulfillmentMethod: 'FBA' } },
  select: { id: true, quantity: true, masterQuantity: true, lastSyncStatus: true, lastSyncedAt: true, externalListingId: true, product: { select: { sku: true, fulfillmentMethod: true } } },
})
const ids = listings.map(l => l.id)
const latest = await prisma.outboundSyncQueue.findMany({ where: { channelListingId: { in: ids }, syncType: 'QUANTITY_UPDATE', syncStatus: 'SUCCESS' }, orderBy: { syncedAt: 'desc' }, take: 5, select: { syncStatus: true, createdAt: true, syncedAt: true, payload: true, channelListingId: true, targetChannel: true } })
console.log(JSON.stringify(latest, null, 1))
console.log('sample listings', listings.slice(0,3).map(l => ({ sku: l.product?.sku, q: l.quantity, mq: l.masterQuantity, st: l.lastSyncStatus, at: l.lastSyncedAt, item: l.externalListingId })))
// distinct products / items
console.log('distinct itemIds', new Set(listings.map(l=>l.externalListingId)).size)
await prisma.$disconnect()
