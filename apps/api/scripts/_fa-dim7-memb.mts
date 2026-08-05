const { default: prisma } = await import('../src/db.js')
const listings = await prisma.channelListing.findMany({
  where: { isPublished: true, listingStatus: { notIn: ['ENDED','REMOVED'] }, channel: 'EBAY', fulfillmentMethod: { not: 'FBA' }, product: { fulfillmentMethod: 'FBA' } },
  select: { id: true, productId: true, externalListingId: true, product: { select: { sku: true } } },
})
const skus = [...new Set(listings.map(l => l.product?.sku).filter(Boolean) as string[])]
const memb = await prisma.sharedListingMembership.findMany({ where: { sku: { in: skus }, status: 'ACTIVE' }, select: { sku: true, itemId: true, marketplace: true, followPool: true, productId: true } })
console.log('mismatch listings', listings.length, 'distinct skus', skus.length, 'ACTIVE memberships for those skus', memb.length)
console.log('memb sample', memb.slice(0,4))
console.log('skus without membership', skus.filter(s => !memb.some(m => m.sku === s)).length)
await prisma.$disconnect()
