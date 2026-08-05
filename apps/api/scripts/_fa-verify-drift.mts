const { default: prisma } = await import('../src/db.js')

const logs = await prisma.syncHealthLog.findMany({
  where: { conflictType: 'CHANNEL_QTY_READBACK', resolutionStatus: 'UNRESOLVED' },
  orderBy: { createdAt: 'desc' },
  take: 30,
  select: { id: true, createdAt: true, channel: true, errorMessage: true, productId: true, conflictData: true },
})
console.log('UNRESOLVED readback logs:', logs.length)
for (const l of logs) {
  console.log('---', l.createdAt.toISOString(), l.channel, l.productId, JSON.stringify(l.errorMessage))
}

// specific membership
const mems = await prisma.sharedListingMembership.findMany({
  where: { sku: { contains: 'GALE-JACKET-YELLOW-MEN-XXS' } },
  select: { sku: true, itemId: true, marketplace: true, productId: true, lastQtyPushed: true, lastPushedAt: true, followPool: true, status: true, stockBuffer: true, lastError: true },
})
console.log('\nMEMBERSHIPS:', JSON.stringify(mems, null, 2))

const pids = [...new Set(mems.map(m => m.productId).filter(Boolean))] as string[]
if (pids.length) {
  const levels = await prisma.stockLevel.findMany({
    where: { productId: { in: pids }, location: { type: 'WAREHOUSE' } },
    select: { productId: true, available: true, quantity: true, location: { select: { code: true, syncRoutes: true } } },
  })
  console.log('\nLEVELS:', JSON.stringify(levels, null, 2))
  const cls = await prisma.channelListing.findMany({
    where: { productId: { in: pids } },
    select: { productId: true, channel: true, marketplace: true, quantity: true, quantityOverride: true, followMasterQuantity: true, syncPaused: true, isPublished: true, listingStatus: true, externalListingId: true, fulfillmentMethod: true },
  })
  console.log('\nCHANNEL LISTINGS:', JSON.stringify(cls, null, 2))
}
await prisma.$disconnect()
