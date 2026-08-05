import '../src/env.js'
const { default: prisma } = await import('../src/db.js')

let n = 0
// count queries via $on is noisy; just time the blocks
const t0 = Date.now()
const listings = await prisma.channelListing.findMany({
  where: { isPublished: true, listingStatus: { notIn: ['ENDED', 'REMOVED'] } },
  select: { productId: true, channel: true, marketplace: true, quantity: true, stockBuffer: true, followMasterQuantity: true, fulfillmentMethod: true, syncPaused: true, sourceLocationCodes: true, product: { select: { sku: true, fulfillmentMethod: true } } },
})
const mems = await prisma.sharedListingMembership.findMany({ where: { status: 'ACTIVE' }, select: { sku: true, itemId: true, marketplace: true, productId: true, lastQtyPushed: true, followPool: true, stockBuffer: true } })
const t1 = Date.now()
const rowPids = [...new Set([...listings.map(l => l.productId), ...mems.map(m => m.productId).filter((p): p is string => !!p)])]
await prisma.stockLevel.findMany({ where: { productId: { in: rowPids }, location: { type: 'WAREHOUSE' } }, select: { productId: true, available: true, location: { select: { code: true, syncRoutes: true } } } })
const t2 = Date.now()
const rowProducts = await prisma.product.findMany({ where: { id: { in: rowPids } }, select: { id: true, parentId: true } })
const masterIds = [...new Set(rowProducts.map(p => p.parentId ?? p.id))]
const t3 = Date.now()
// resolveCanonicalMasters
const [withChildren, masterSkus] = await Promise.all([
  prisma.product.findMany({ where: { parentId: { in: masterIds } }, select: { parentId: true }, distinct: ['parentId'] }),
  prisma.product.findMany({ where: { id: { in: masterIds } }, select: { id: true, sku: true } }),
])
const mwc = new Set(withChildren.map(p => p.parentId!))
const childless = masterIds.filter(id => !mwc.has(id))
const cls = await prisma.channelListing.findMany({ where: { productId: { in: childless }, externalListingId: { not: null } }, select: { productId: true, externalListingId: true } })
const all = [...new Set(cls.map(c => c.externalListingId!).filter(Boolean))]
const ms = await prisma.sharedListingMembership.findMany({ where: { itemId: { in: all } }, select: { itemId: true, productId: true } })
await prisma.product.findMany({ where: { id: { in: [...new Set(ms.map(m => m.productId).filter((x): x is string => !!x))] } }, select: { id: true, parentId: true } })
const t4 = Date.now()
// SECOND buildLedgers call in the products route (duplicate of t1->t2 work)
await prisma.stockLevel.findMany({ where: { productId: { in: rowPids }, location: { type: 'WAREHOUSE' } }, select: { productId: true, available: true, location: { select: { code: true, syncRoutes: true } } } })
const t5 = Date.now()
console.log('listings+memberships', t1 - t0, 'ms')
console.log('buildLedgers #1     ', t2 - t1, 'ms')
console.log('rowProducts         ', t3 - t2, 'ms')
console.log('resolveCanonical(5q)', t4 - t3, 'ms   childlessMasters=', childless.length, 'itemIds=', all.length, 'memRows=', ms.length)
console.log('buildLedgers #2 DUP ', t5 - t4, 'ms')
console.log('TOTAL               ', t5 - t0, 'ms')
await prisma.$disconnect()
