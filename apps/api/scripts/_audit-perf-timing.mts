const { default: prisma } = await import('../src/db.js')
const t = async <T>(label: string, fn: () => Promise<T>): Promise<T> => {
  const s = Date.now(); const r = await fn(); console.log(`[t] ${label}: ${Date.now() - s}ms`); return r
}
// warm
await prisma.$queryRaw`SELECT 1`

const listings = await t('listings', () => prisma.channelListing.findMany({
  where: { isPublished: true, listingStatus: { notIn: ['ENDED', 'REMOVED'] } },
  select: { productId: true, channel: true, marketplace: true, quantity: true },
}))
const memberships = await t('memberships', () => prisma.sharedListingMembership.findMany({
  where: { status: 'ACTIVE' }, select: { sku: true, itemId: true, productId: true },
}))
const pids = [...new Set([...listings.map(l => l.productId), ...memberships.map(m => m.productId).filter(Boolean) as string[]])]
console.log('listings', listings.length, 'memberships', memberships.length, 'pids', pids.length)
const ledger1 = await t('buildLedgers#1', () => prisma.stockLevel.findMany({
  where: { productId: { in: pids }, location: { type: 'WAREHOUSE' } },
  select: { productId: true, available: true, location: { select: { code: true, syncRoutes: true } } },
}))
const ledger2 = await t('buildLedgers#2 (duplicate)', () => prisma.stockLevel.findMany({
  where: { productId: { in: pids }, location: { type: 'WAREHOUSE' } },
  select: { productId: true, available: true, location: { select: { code: true, syncRoutes: true } } },
}))
console.log('ledger rows', ledger1.length, ledger2.length)
const rowProducts = await t('rowProducts', () => prisma.product.findMany({ where: { id: { in: pids } }, select: { id: true, parentId: true } }))
const masterIds = [...new Set(rowProducts.map(p => p.parentId ?? p.id))]
console.log('masters', masterIds.length)
const canonStart = Date.now()
const [withChildren, masterSkus] = await Promise.all([
  prisma.product.findMany({ where: { parentId: { in: masterIds } }, select: { parentId: true }, distinct: ['parentId'] }),
  prisma.product.findMany({ where: { id: { in: masterIds } }, select: { id: true, sku: true } }),
])
const withKids = new Set(withChildren.map(p => p.parentId!))
const childless = masterIds.filter(id => !withKids.has(id))
const cls = await prisma.channelListing.findMany({ where: { productId: { in: childless }, externalListingId: { not: null } }, select: { productId: true, externalListingId: true } })
const itemIds = [...new Set(cls.map(c => c.externalListingId!))]
const mem = await prisma.sharedListingMembership.findMany({ where: { itemId: { in: itemIds }, status: 'ACTIVE' }, select: { itemId: true, productId: true } })
const memPids = [...new Set(mem.map(m => m.productId).filter(Boolean) as string[])]
const memProds = await prisma.product.findMany({ where: { id: { in: memPids } }, select: { id: true, parentId: true } })
console.log(`[t] resolveCanonicalMasters TOTAL: ${Date.now() - canonStart}ms  (childless=${childless.length}, itemIds=${itemIds.length}, memberships=${mem.length}, memProds=${memProds.length})`)
await prisma.$disconnect()
