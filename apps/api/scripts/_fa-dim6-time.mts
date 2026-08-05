const { default: prisma } = await import('../src/db.js')
const t0 = Date.now()
const [a, b] = await Promise.all([
  prisma.channelListing.findMany({ where: { isPublished: true, listingStatus: { notIn: ['ENDED','REMOVED'] } }, select: { productId: true, channel: true, marketplace: true, quantity: true, stockBuffer: true, followMasterQuantity: true, fulfillmentMethod: true, syncPaused: true, sourceLocationCodes: true, product: { select: { sku: true, fulfillmentMethod: true } } } }),
  prisma.sharedListingMembership.findMany({ where: { status: 'ACTIVE' }, select: { sku: true, itemId: true, marketplace: true, productId: true, lastQtyPushed: true, followPool: true, stockBuffer: true } }),
])
console.log('computeRows base queries ms=', Date.now()-t0, 'listings=', a.length, 'mems=', b.length)
await prisma.$disconnect()
