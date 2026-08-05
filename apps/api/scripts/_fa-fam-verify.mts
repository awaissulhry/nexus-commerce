import '../src/env.js'
const { default: prisma } = await import('../src/db.js')
const memb = await prisma.sharedListingMembership.findMany({ select: { itemId: true, marketplace: true, productId: true, sku: true } })
const prods = await prisma.product.findMany({ select: { id: true, sku: true, parentId: true } })
const byId = new Map(prods.map(p => [p.id, p]))
const famByMaster = new Map<string, Set<string>>()
for (const m of memb) {
  const p = m.productId ? byId.get(m.productId) : null; if (!p) continue
  const mid = p.parentId ?? p.id
  if (!famByMaster.has(mid)) famByMaster.set(mid, new Set())
  famByMaster.get(mid)!.add(`EBAY:${m.marketplace}:${m.itemId}`)
}
const rows = [...famByMaster.entries()].filter(([,s]) => s.size > 1)
  .map(([mid, s]) => ({ sku: byId.get(mid)?.sku, ebayFamilies: s.size }))
  .sort((a,b)=>b.ebayFamilies-a.ebayFamilies)
console.log('masters with >1 ebay family:', rows.length)
console.log(JSON.stringify(rows.slice(0,12)))
await prisma.$disconnect()
