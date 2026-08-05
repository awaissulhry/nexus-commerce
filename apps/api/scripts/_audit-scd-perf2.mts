import '../src/env.js'
const { default: prisma } = await import('../src/db.js')
await prisma.$queryRaw`SELECT 1` // warm

const rowProducts0 = await prisma.channelListing.findMany({ where: { isPublished: true, listingStatus: { notIn: ['ENDED', 'REMOVED'] } }, select: { productId: true } })
const mems0 = await prisma.sharedListingMembership.findMany({ where: { status: 'ACTIVE' }, select: { productId: true } })
const rowPids = [...new Set([...rowProducts0.map(l => l.productId), ...mems0.map(m => m.productId).filter((p): p is string => !!p)])]
const rp = await prisma.product.findMany({ where: { id: { in: rowPids } }, select: { id: true, parentId: true } })
const masterIds = [...new Set(rp.map(p => p.parentId ?? p.id))]

const time = async (label: string, fn: () => Promise<unknown>) => {
  const runs: number[] = []
  for (let i = 0; i < 3; i++) { const t = Date.now(); await fn(); runs.push(Date.now() - t) }
  console.log(label.padEnd(34), runs.join(' / '), 'ms')
}
await time('A withChildren(parentId in 37)', () => prisma.product.findMany({ where: { parentId: { in: masterIds } }, select: { parentId: true }, distinct: ['parentId'] }))
await time('B masterSkus(id in 37)', () => prisma.product.findMany({ where: { id: { in: masterIds } }, select: { id: true, sku: true } }))
const withChildren = await prisma.product.findMany({ where: { parentId: { in: masterIds } }, select: { parentId: true }, distinct: ['parentId'] })
const mwc = new Set(withChildren.map(p => p.parentId!))
const childless = masterIds.filter(id => !mwc.has(id))
await time('C channelListing(childless 22)', () => prisma.channelListing.findMany({ where: { productId: { in: childless }, externalListingId: { not: null } }, select: { productId: true, externalListingId: true } }))
const cls = await prisma.channelListing.findMany({ where: { productId: { in: childless }, externalListingId: { not: null } }, select: { productId: true, externalListingId: true } })
const itemIds = [...new Set(cls.map(c => c.externalListingId!))]
await time('D membership(itemId in N)', () => prisma.sharedListingMembership.findMany({ where: { itemId: { in: itemIds } }, select: { itemId: true, productId: true } }))
const ms = await prisma.sharedListingMembership.findMany({ where: { itemId: { in: itemIds } }, select: { itemId: true, productId: true } })
const pids = [...new Set(ms.map(m => m.productId).filter((x): x is string => !!x))]
await time('E memberProducts(id in N)', () => prisma.product.findMany({ where: { id: { in: pids } }, select: { id: true, parentId: true } }))
await time('F buildLedgers (called TWICE)', () => prisma.stockLevel.findMany({ where: { productId: { in: rowPids }, location: { type: 'WAREHOUSE' } }, select: { productId: true, available: true, location: { select: { code: true, syncRoutes: true } } } }))
await time('G computeRows listings', () => prisma.channelListing.findMany({ where: { isPublished: true, listingStatus: { notIn: ['ENDED', 'REMOVED'] } }, select: { productId: true, channel: true, marketplace: true, quantity: true, stockBuffer: true, followMasterQuantity: true, fulfillmentMethod: true, syncPaused: true, sourceLocationCodes: true, product: { select: { sku: true, fulfillmentMethod: true } } } }))
await time('H masterMeta w/ images', () => prisma.product.findMany({ where: { id: { in: masterIds } }, select: { id: true, sku: true, name: true, family: { select: { code: true, label: true } }, images: { select: { id: true, url: true } }, parent: { select: { images: { select: { id: true, url: true } } } } } }))
await prisma.$disconnect()
