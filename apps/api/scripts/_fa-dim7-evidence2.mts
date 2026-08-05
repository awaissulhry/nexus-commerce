const { default: prisma } = await import('../src/db.js')

const ids = ['cmp27jo4o01swnv01gjekq9hu', 'cmp26ao5r00blrx01c03ez78u']
const rows = await prisma.channelListing.findMany({
  where: { id: { in: ids } },
  select: { id: true, channel: true, marketplace: true, fulfillmentMethod: true, quantity: true, followMasterQuantity: true, syncPaused: true, isPublished: true, listingStatus: true, product: { select: { sku: true, id: true, fulfillmentMethod: true } } },
})
console.log(JSON.stringify(rows, null, 1))

const q = await prisma.outboundSyncQueue.findMany({
  where: { channelListingId: { in: ids }, syncType: 'QUANTITY_UPDATE' },
  select: { syncStatus: true, createdAt: true, payload: true, errorMessage: true },
  orderBy: { createdAt: 'desc' }, take: 6,
})
console.log(JSON.stringify(q, null, 1))

// FBA stock buckets for those products
const pids = rows.map((r) => r.product?.id).filter(Boolean) as string[]
const lv = await prisma.stockLevel.findMany({ where: { productId: { in: pids } }, select: { productId: true, quantity: true, available: true, location: { select: { code: true, type: true, syncRoutes: true } } } })
console.log(JSON.stringify(lv, null, 1))
await prisma.$disconnect()
