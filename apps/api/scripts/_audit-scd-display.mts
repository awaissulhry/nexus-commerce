import '../src/env.js'
const { default: prisma } = await import('../src/db.js')

const groups = ['GALE-JACKET', 'xavia-knee-slider', 'normal-knee-slider', 'IT-MOSS-JACKET', 'AIREON']
for (const sku of groups) {
  const g = await prisma.product.findFirst({ where: { sku }, select: { id: true, sku: true, name: true } })
  if (!g) continue
  const kids = await prisma.product.findMany({ where: { parentId: g.id }, select: { id: true } })
  const canonicalPids = [g.id, ...kids.map(k => k.id)]
  // find folded members by stem/pool: approximate with sku LIKE
  const cand = await prisma.product.findMany({ where: { sku: { startsWith: sku } }, select: { id: true, sku: true, parentId: true } })
  const dupMasters = cand.filter(c => c.sku !== sku && !c.parentId)
  const allPidsRaw = [...canonicalPids, ...dupMasters.map(d => d.id)]
  const listings = await prisma.channelListing.findMany({ where: { isPublished: true, listingStatus: { notIn: ['ENDED','REMOVED'] }, productId: { in: allPidsRaw } }, select: { productId: true } })
  const mems = await prisma.sharedListingMembership.findMany({ where: { status: 'ACTIVE', productId: { in: allPidsRaw } }, select: { productId: true } })
  const variantPids = [...new Set([...listings.map(l => l.productId), ...mems.map(m => m.productId!).filter(Boolean)])]
  const lv = await prisma.stockLevel.findMany({ where: { productId: { in: variantPids }, location: { type: 'WAREHOUSE' } }, select: { productId: true, available: true } })
  const pool = new Map<string, number>()
  for (const l of lv) pool.set(l.productId, (pool.get(l.productId) ?? 0) + l.available)
  const poolTotal = variantPids.reduce((s,p) => s + (pool.get(p) ?? 0), 0)
  const inStock = variantPids.filter(p => (pool.get(p) ?? 0) > 0).length
  console.log(`${sku}: displayed "${poolTotal} u · ${inStock}/${variantPids.length}"  |  real sellable variants = ${kids.length}  (dup masters folded: ${dupMasters.length}, master itself: 1)`)
}
await prisma.$disconnect()
