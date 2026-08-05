// READ-ONLY probe: do isPublished/non-ENDED ChannelListings and ACTIVE shared
// memberships hang off DELETED products (which computeRows hides), reachable
// from a LIVE master via the POST /actions masterIds expansion?
const { default: prisma } = await import('../src/db.js')

// 1. Listings on deleted products whose master (parent) is LIVE.
const cls = await prisma.channelListing.findMany({
  where: {
    isPublished: true,
    listingStatus: { notIn: ['ENDED', 'REMOVED'] },
    product: { deletedAt: { not: null } },
  },
  select: {
    id: true, channel: true, marketplace: true, listingStatus: true,
    product: { select: { id: true, sku: true, deletedAt: true, parentId: true, parent: { select: { id: true, sku: true, deletedAt: true } } } },
  },
})
const liveMasterCls = cls.filter((c) => c.product?.parent && c.product.parent.deletedAt === null)
const orphanTopCls = cls.filter((c) => !c.product?.parentId)
console.log(`isPublished/non-ENDED listings on DELETED products: ${cls.length}`)
console.log(`  ... whose PARENT master is LIVE (reachable via expansion): ${liveMasterCls.length}`)
console.log(`  ... on deleted TOP-LEVEL products: ${orphanTopCls.length}`)
const byMaster = new Map<string, number>()
for (const c of liveMasterCls) {
  const k = c.product!.parent!.sku
  byMaster.set(k, (byMaster.get(k) ?? 0) + 1)
}
console.log('per LIVE master:', JSON.stringify([...byMaster.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10)))
const sample = liveMasterCls.slice(0, 5).map((c) => `${c.product!.sku}@${c.channel}:${c.marketplace}(${c.listingStatus})`)
console.log('sample rows:', sample.join(' | '))

// 2. ACTIVE shared memberships pointing at deleted products (no relation on
// the model — mirror computeRows' two-step lookup).
const allMems = await prisma.sharedListingMembership.findMany({
  where: { status: 'ACTIVE' },
  select: { itemId: true, sku: true, marketplace: true, productId: true },
})
const memPids = [...new Set(allMems.map((m) => m.productId).filter((x): x is string => !!x))]
const memProducts = await prisma.product.findMany({
  where: { id: { in: memPids } },
  select: { id: true, deletedAt: true, parentId: true, parent: { select: { deletedAt: true, sku: true } } },
})
const pById = new Map(memProducts.map((p) => [p.id, p]))
const deletedMems = allMems.filter((m) => m.productId && pById.get(m.productId)?.deletedAt != null)
const liveMasterMems = deletedMems.filter((m) => {
  const p = pById.get(m.productId!)
  return p?.parent && p.parent.deletedAt === null
})
console.log(`ACTIVE memberships on DELETED products: ${deletedMems.length}; with LIVE parent master: ${liveMasterMems.length}`)

await prisma.$disconnect()
process.exit(0)
