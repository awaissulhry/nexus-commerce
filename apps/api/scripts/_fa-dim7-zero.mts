const { default: prisma } = await import('../src/db.js')
const p = await prisma.product.findUnique({ where: { id: 'cmokmy38o0074pm0p4ocgo1ug' }, select: { sku: true, name: true, parentId: true, totalStock: true } })
console.log('product', JSON.stringify(p))
const cls = await prisma.channelListing.findMany({ where: { productId: 'cmokmy38o0074pm0p4ocgo1ug' }, select: { channel: true, marketplace: true, quantity: true, externalListingId: true, isPublished: true, listingStatus: true, followMasterQuantity: true } })
console.log('listings', JSON.stringify(cls))
const lv = await prisma.stockLevel.count({ where: { productId: 'cmokmy38o0074pm0p4ocgo1ug' } })
console.log('stockLevel rows', lv)

// how many of the 34 uncounted-null rows are EBAY parent listings that own a shared pool item?
const nullRows = await prisma.channelListing.findMany({
  where: { quantity: null, isPublished: true, listingStatus: { notIn: ['ENDED', 'REMOVED'] }, followMasterQuantity: true },
  select: { channel: true, marketplace: true, externalListingId: true, product: { select: { sku: true, id: true } } },
})
const ebayNull = nullRows.filter((r) => r.channel === 'EBAY' && r.externalListingId)
const memCounts = await prisma.sharedListingMembership.groupBy({ by: ['itemId'], where: { itemId: { in: ebayNull.map((e) => e.externalListingId!) }, status: 'ACTIVE' }, _count: true })
console.log('EBAY null-qty follow listings with an itemId:', ebayNull.length)
console.log(JSON.stringify(ebayNull.map((e) => ({ sku: e.product?.sku, item: e.externalListingId, members: memCounts.find((m) => m.itemId === e.externalListingId)?._count ?? 0 })), null, 1))
await prisma.$disconnect()
