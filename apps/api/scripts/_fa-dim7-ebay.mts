const { default: prisma } = await import('../src/db.js')

const ebay = await prisma.channelListing.findMany({
  where: { channel: 'EBAY', isPublished: true, listingStatus: { notIn: ['ENDED', 'REMOVED'] }, fulfillmentMethod: { not: 'FBA' }, product: { fulfillmentMethod: 'FBA' } },
  select: { id: true, marketplace: true, quantity: true, followMasterQuantity: true, syncPaused: true, stockBuffer: true, externalListingId: true, product: { select: { id: true, sku: true } } },
})
console.log('EBAY listings SC calls FBA:', ebay.length)
const ids = ebay.map((e) => e.id)
const q = await prisma.outboundSyncQueue.findMany({
  where: { channelListingId: { in: ids }, syncType: 'QUANTITY_UPDATE' },
  select: { channelListingId: true, syncStatus: true, createdAt: true, payload: true },
  orderBy: { createdAt: 'desc' }, take: 8,
})
console.log('recent eBay QUANTITY_UPDATE queue rows:', q.length)
for (const r of q) console.log(r.createdAt.toISOString(), r.syncStatus, JSON.stringify(r.payload))
const cnt = await prisma.outboundSyncQueue.groupBy({ by: ['syncStatus'], where: { channelListingId: { in: ids }, syncType: 'QUANTITY_UPDATE' }, _count: true })
console.log('by status:', JSON.stringify(cnt))

// what would SC show vs engine for one of them
const one = ebay.find((e) => e.product?.sku === 'GALE-JACKET-BLACK-MEN-XS') ?? ebay[0]
console.log('sample', JSON.stringify(one, null, 1))
const lv = await prisma.stockLevel.findMany({ where: { productId: one.product!.id }, select: { quantity: true, available: true, location: { select: { code: true, type: true, syncRoutes: true } } } })
console.log('ledger', JSON.stringify(lv))
const mem = await prisma.sharedListingMembership.findMany({ where: { productId: one.product!.id }, select: { itemId: true, sku: true, marketplace: true, followPool: true, status: true, lastQtyPushed: true, stockBuffer: true } })
console.log('memberships', JSON.stringify(mem, null, 1))
await prisma.$disconnect()
