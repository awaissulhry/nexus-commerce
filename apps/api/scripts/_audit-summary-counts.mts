const { default: prisma } = await import('../src/db.js')
const listings = await prisma.channelListing.findMany({
  where: { isPublished: true, listingStatus: { notIn: ['ENDED', 'REMOVED'] } },
  select: { productId: true },
})
const mems = await prisma.sharedListingMembership.findMany({ where: { status: 'ACTIVE' }, select: { productId: true } })
const rows = listings.length + mems.length
const pids = new Set<string>()
for (const l of listings) if (l.productId) pids.add(l.productId)
for (const m of mems) if (m.productId) pids.add(m.productId)
const prods = await prisma.product.findMany({ where: { id: { in: [...pids] } }, select: { id: true, parentId: true } })
const masters = new Set(prods.map((p) => p.parentId ?? p.id))
console.log(JSON.stringify({ rowsTile: rows, productsTile: pids.size, distinctMasters: masters.size }))
await prisma.$disconnect()
