const { default: prisma } = await import('../src/db.js')
const prods = await prisma.product.findMany({ where: { sku: { startsWith: 'GALE-JACKET' } }, select: { id: true, sku: true, fulfillmentMethod: true, parentId: true } })
const ids = prods.map(p => p.id)
const cls = await prisma.channelListing.findMany({
  where: { productId: { in: ids }, isPublished: true, listingStatus: { notIn: ['ENDED','REMOVED'] } },
  select: { channel: true, marketplace: true, fulfillmentMethod: true, quantity: true, product: { select: { sku: true, fulfillmentMethod: true } } },
})
const memb = await prisma.sharedListingMembership.count({ where: { productId: { in: ids }, status: 'ACTIVE' } })
const fbaCount = cls.filter(c => c.fulfillmentMethod === 'FBA' || (c.fulfillmentMethod == null && c.product?.fulfillmentMethod === 'FBA') || c.product?.fulfillmentMethod === 'FBA').length
console.log('GALE products:', prods.length, 'listings:', cls.length, 'guard-FBA:', fbaCount, 'ACTIVE memberships:', memb)
const byCh: Record<string,number> = {}
for (const c of cls) byCh[c.channel] = (byCh[c.channel]??0)+1
console.log('listings by channel:', byCh)
console.log('rollup.listings (LISTING+SHARED lanes) =', cls.length + memb, '| modeFBA would be', fbaCount, '=> allFba?', (cls.length+memb)>0 && fbaCount === (cls.length+memb))
await prisma.$disconnect()
