const { default: prisma } = await import('../src/db.js')

const skus = ['VENTRA-JACKET-ALT1','REGAL-JACKET-ALT1','VENTRA-JACKET-ALT2']
const prods = await prisma.product.findMany({
  where: { sku: { in: skus } },
  select: { id: true, sku: true, parentId: true, totalStock: true, fulfillmentMethod: true,
    children: { select: { id: true } },
    channelListings: { select: { id: true, channel: true, marketplace: true, region: true, quantity: true, masterQuantity: true, followMasterQuantity: true, syncPaused: true, isPublished: true, listingStatus: true, externalListingId: true, fulfillmentMethod: true, lastSyncStatus: true, lastSyncedAt: true, updatedAt: true } },
    stockLevels: { select: { quantity: true, available: true, location: { select: { code: true, type: true, syncRoutes: true } } } },
  },
})
for (const p of prods) {
  console.log('=== ', p.sku, p.id, 'children', p.children.length, 'totalStock', p.totalStock, 'ff', p.fulfillmentMethod)
  console.log('  stockLevels', JSON.stringify(p.stockLevels))
  for (const cl of p.channelListings) console.log('  CL', JSON.stringify(cl))
  for (const cl of p.channelListings) {
    if (!cl.externalListingId) continue
    const mem = await prisma.sharedListingMembership.groupBy({ by: ['status'], where: { itemId: cl.externalListingId }, _count: true })
    console.log('  memberships for', cl.externalListingId, JSON.stringify(mem))
  }
}
await prisma.$disconnect()
