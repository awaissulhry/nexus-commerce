/** READ-ONLY: confirm the exact DB link — a duplicate listing's memberships
 *  point at the CANONICAL master's variant products. Derivable grouping. */
const { default: prisma } = await import('../src/db.js')
const dup = await prisma.product.findFirst({ where: { sku: 'GALE-JACKET-ALT1' }, select: { id: true } })
const cls = await prisma.channelListing.findMany({ where: { productId: dup!.id }, select: { externalListingId: true } })
const itemIds = cls.map(c=>c.externalListingId).filter(Boolean) as string[]
console.log(`GALE-JACKET-ALT1 listing itemIds: ${itemIds.join(', ')}`)
const mems = await prisma.sharedListingMembership.findMany({ where: { itemId: { in: itemIds } }, select: { sku: true, productId: true }, take: 5 })
for (const m of mems) {
  const p = await prisma.product.findUnique({ where: { id: m.productId ?? '' }, select: { sku: true, parentId: true } })
  const master = p?.parentId ? await prisma.product.findUnique({ where: { id: p.parentId }, select: { sku: true } }) : p
  console.log(`  membership sku=${m.sku} → product=${p?.sku} → master=${master?.sku}`)
}
// Count: across ALL masters, how many resolve to a canonical via this membership→product→master path?
const masters = await prisma.product.findMany({ where: { parentId: null }, select: { id: true, sku: true } })
let derivable = 0, canonical = 0, orphan = 0
for (const m of masters) {
  const kids = await prisma.product.count({ where: { parentId: m.id } })
  if (kids > 0) { canonical++; continue }  // owns children = canonical (or standalone)
  const its = (await prisma.channelListing.findMany({ where: { productId: m.id }, select: { externalListingId: true } })).map(c=>c.externalListingId).filter(Boolean) as string[]
  const mem = its.length ? await prisma.sharedListingMembership.findFirst({ where: { itemId: { in: its } }, select: { productId: true } }) : null
  if (mem?.productId) {
    const pp = await prisma.product.findUnique({ where: { id: mem.productId }, select: { parentId: true } })
    if (pp?.parentId && pp.parentId !== m.id) derivable++
  } else orphan++
}
console.log(`\nmasters=${masters.length}: own-children(canonical/standalone)=${canonical}, duplicate-derivable-via-pool=${derivable}, no-pool-orphan=${orphan}`)
await prisma.$disconnect()
