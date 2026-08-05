/** READ-ONLY probe 2: market token shapes + family fan-out per product. */
const { default: prisma } = await import('../src/db.js')

const mkts = await prisma.channelListing.groupBy({ by: ['marketplace'], _count: true })
console.log('ALL ChannelListing marketplaces:', mkts.map((m) => `${m.marketplace}(${m._count})`).join(', '))
const mm = await prisma.sharedListingMembership.groupBy({ by: ['marketplace'], _count: true })
console.log('ALL membership marketplaces  :', mm.map((m) => `${m.marketplace}(${m._count})`).join(', '))

// families per product group = distinct itemIds among ACTIVE memberships + amazon channel:market pairs
const mems = await prisma.sharedListingMembership.findMany({
  where: { status: 'ACTIVE' },
  select: { itemId: true, productId: true, marketplace: true },
})
const prods = await prisma.product.findMany({
  where: { id: { in: [...new Set(mems.map((m) => m.productId).filter(Boolean) as string[])] } },
  select: { id: true, parentId: true, sku: true },
})
const masterOf = new Map(prods.map((p) => [p.id, p.parentId ?? p.id]))
const familiesByMaster = new Map<string, Set<string>>()
for (const m of mems) {
  if (!m.productId) continue
  const mid = masterOf.get(m.productId) ?? m.productId
  const s = familiesByMaster.get(mid) ?? new Set<string>()
  s.add(`EBAY:${m.marketplace}:${m.itemId}`)
  familiesByMaster.set(mid, s)
}
const names = await prisma.product.findMany({ where: { id: { in: [...familiesByMaster.keys()] } }, select: { id: true, sku: true } })
const skuOf = new Map(names.map((n) => [n.id, n.sku]))
console.log('\nmasters with >1 eBay listing family (shared pool):')
for (const [mid, s] of familiesByMaster) if (s.size > 1) console.log(' ', skuOf.get(mid), '→', s.size, 'families')
process.exit(0)
