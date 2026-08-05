/** READ-ONLY: snapshot a group's control state, so a bulk action can be proven net-zero. */
const { default: prisma } = await import('../src/db.js')
const canonical = await prisma.product.findFirst({ where: { sku: 'AIRMESH-JACKET', parentId: null }, select: { id: true, sku: true } })
if (!canonical) { console.log('NOT FOUND'); process.exit(1) }
const variants = await prisma.product.findMany({ where: { parentId: canonical.id }, select: { id: true } })
const pids = [canonical.id, ...variants.map((v) => v.id)]
const dup = await prisma.product.findFirst({ where: { sku: 'AIRMESH-JACKET-ALT1' }, select: { id: true } })
if (dup) pids.push(dup.id)
const cls = await prisma.channelListing.findMany({
  where: { productId: { in: pids }, isPublished: true, listingStatus: { notIn: ['ENDED', 'REMOVED'] } },
  select: { id: true, syncPaused: true, followMasterQuantity: true, quantity: true },
})
const mem = await prisma.sharedListingMembership.findMany({
  where: { productId: { in: pids }, status: 'ACTIVE' },
  select: { id: true, followPool: true },
})
console.log(JSON.stringify({
  group: canonical.sku,
  canonicalId: canonical.id,
  productIds: pids.length,
  listings: cls.length,
  listingsPaused: cls.filter((c) => c.syncPaused).length,
  listingsFollowing: cls.filter((c) => c.followMasterQuantity).length,
  memberships: mem.length,
  membershipsFollowPool: mem.filter((m) => m.followPool).length,
}, null, 1))
await prisma.$disconnect()
