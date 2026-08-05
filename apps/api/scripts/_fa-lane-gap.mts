const { default: prisma } = await import('../src/db.js')

// find GALE canonical family
const masters = await prisma.product.findMany({
  where: { parentId: null, sku: { contains: 'GALE' } },
  select: { id: true, sku: true },
})
console.log('MASTERS', masters.map(m => `${m.sku}:${m.id}`).join('\n'))

const ids = masters.map(m => m.id)
const kids = await prisma.product.findMany({ where: { parentId: { in: ids } }, select: { id: true, sku: true } })
const pids = [...ids, ...kids.map(k => k.id)]
console.log('variants', kids.length)

const cls = await prisma.channelListing.groupBy({
  by: ['channel', 'marketplace', 'syncPaused', 'followMasterQuantity'],
  where: { productId: { in: pids }, isPublished: true, listingStatus: { notIn: ['ENDED','REMOVED'] } },
  _count: true,
})
console.log('CHANNEL LISTINGS', JSON.stringify(cls, null, 1))

const mems = await prisma.sharedListingMembership.groupBy({
  by: ['itemId', 'marketplace', 'followPool'],
  where: { productId: { in: pids }, status: 'ACTIVE' },
  _count: true,
})
console.log('MEMBERSHIPS', JSON.stringify(mems, null, 1))

// do the eBay ChannelListings share the same externalListingId as membership itemIds?
const ebayCls = await prisma.channelListing.findMany({
  where: { productId: { in: pids }, channel: 'EBAY' },
  select: { productId: true, marketplace: true, externalListingId: true, syncPaused: true, quantity: true, isPublished: true, listingStatus: true },
  take: 40,
})
console.log('EBAY CL sample', JSON.stringify(ebayCls.slice(0, 15), null, 1), 'total', ebayCls.length)
const itemIds = new Set(mems.map(m => m.itemId))
const clExt = new Set(ebayCls.map(c => c.externalListingId).filter(Boolean))
console.log('membership itemIds', [...itemIds])
console.log('EBAY CL externalIds', [...clExt])
console.log('overlap', [...clExt].filter(x => itemIds.has(x as string)))
await prisma.$disconnect()
