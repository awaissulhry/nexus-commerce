/** READ-ONLY: RT.5 verify — pin state + push queue after blanket unpin. */
const { default: prisma } = await import('../src/db.js')
const byChannel = await prisma.channelListing.groupBy({
  by: ['channel'],
  where: { channel: { in: ['AMAZON', 'EBAY', 'SHOPIFY'] }, followMasterQuantity: false, listingStatus: { not: 'ENDED' } },
  _count: { _all: true },
})
console.log('still pinned (non-ENDED):', JSON.stringify(byChannel.map((b) => `${b.channel}=${b._count._all}`)))
const stillPinnedFbm = await prisma.channelListing.findMany({
  where: { channel: 'AMAZON', followMasterQuantity: false, listingStatus: { not: 'ENDED' } },
  select: { fulfillmentMethod: true, product: { select: { fulfillmentMethod: true, sku: true } } },
})
const fbmLeft = stillPinnedFbm.filter(
  (l) => !((l.fulfillmentMethod === 'FBA') || (l.fulfillmentMethod == null && l.product?.fulfillmentMethod === 'FBA')),
)
console.log(`of AMAZON pinned: FBA=${stillPinnedFbm.length - fbmLeft.length} FBM-left=${fbmLeft.length}`)
for (const l of fbmLeft.slice(0, 5)) console.log('  FBM still pinned:', l.product?.sku)
const q = await prisma.outboundSyncQueue.groupBy({
  by: ['syncStatus'],
  where: { syncType: 'QUANTITY_UPDATE', createdAt: { gte: new Date(Date.now() - 20 * 60e3) } },
  _count: { _all: true },
})
console.log('qty rows last 20min:', JSON.stringify(q.map((r) => `${r.syncStatus}=${r._count._all}`)))
await prisma.$disconnect()
process.exit(0)
