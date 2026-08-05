import '../src/env.js'
const { default: prisma } = await import('../src/db.js')

// Do canonical MASTER products themselves have their own published listing rows
// (which is what puts their productId into allPids and inflates variantCount)?
const groupSkus = ['GALE-JACKET','AIREON','AIRMESH-JACKET','AIR-MESH-JACKET-MEN','VENTRA-JACKET','REGAL-JACKET','IT-MOSS-JACKET','xracing','WATERPROOF-OVERJACKET-BLACK-MEN','xavia-knee-slider','normal-knee-slider']
const masters = await prisma.product.findMany({ where: { sku: { in: groupSkus } }, select: { id: true, sku: true } })
for (const m of masters) {
  const ls = await prisma.channelListing.findMany({
    where: { productId: m.id, isPublished: true, listingStatus: { notIn: ['ENDED','REMOVED'] } },
    select: { channel: true, marketplace: true, externalListingId: true, listingStatus: true },
  })
  const mem = await prisma.sharedListingMembership.count({ where: { productId: m.id, status: 'ACTIVE' } })
  const lv = await prisma.stockLevel.findMany({ where: { productId: m.id, location: { type: 'WAREHOUSE' } }, select: { available: true, location: { select: { code: true } } } })
  const stock = lv.reduce((s,x)=>s+x.available,0)
  console.log(m.sku.padEnd(34), 'ownListings=' + ls.length, 'ownActiveMemberships=' + mem, 'ownWarehouseStock=' + stock,
    ls.length ? '  ' + ls.map(l=>`${l.channel}/${l.marketplace}/${l.listingStatus}/${l.externalListingId}`).join(' ') : '')
}

// AIRMESH-JACKET is the boundary case: 20 real children -> variantCount 21 -> omitted
console.log('\n--- AIRMESH-JACKET boundary check ---')
const am = masters.find(m => m.sku === 'AIRMESH-JACKET')!
const kids = await prisma.product.count({ where: { parentId: am.id } })
console.log('real children =', kids, '| threshold =', 20, '| variantCount reported = ', kids + 1, '| omitChildrenInList =', kids + 1 > 20)

await prisma.$disconnect()
