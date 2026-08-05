import '../src/env.js'
const { default: prisma } = await import('../src/db.js')

for (const sku of ['GALE-JACKET', 'AIRMESH-JACKET', 'xavia-knee-slider']) {
  const master = await prisma.product.findFirst({ where: { sku }, select: { id: true, sku: true } })
  if (!master) continue
  const kids = await prisma.product.findMany({ where: { parentId: master.id }, select: { id: true, sku: true } })
  const kidIds = new Set(kids.map((k) => k.id))
  console.log(`\n### ${sku} master=${master.id} dbKids=${kids.length}`)
  // pids in row universe belonging to this family (children) + master itself
  const listings = await prisma.channelListing.findMany({
    where: { isPublished: true, listingStatus: { notIn: ['ENDED', 'REMOVED'] }, productId: { in: [master.id, ...kidIds] } },
    select: { productId: true, channel: true, marketplace: true },
  })
  const mems = await prisma.sharedListingMembership.findMany({
    where: { status: 'ACTIVE', productId: { in: [master.id, ...kidIds] } },
    select: { productId: true, itemId: true },
  })
  const listedKids = new Set([...listings, ...mems].map((r) => r.productId!).filter((p) => kidIds.has(p)))
  const masterRows = [...listings, ...mems].filter((r) => r.productId === master.id).length
  console.log(`  listed kids with rows: ${listedKids.size} / ${kids.length}`)
  console.log(`  master's OWN rows in universe: ${masterRows}`)
  console.log(`  => variantPids would be ${listedKids.size} + 1(master) = ${listedKids.size + 1}`)
  const ms = await prisma.stockLevel.findMany({ where: { productId: master.id, location: { type: 'WAREHOUSE' } }, select: { available: true } })
  console.log(`  master WAREHOUSE stock rows: ${JSON.stringify(ms)}`)
}
await prisma.$disconnect()
