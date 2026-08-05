import '../src/env.js'
const { default: prisma } = await import('../src/db.js')

const listings = await prisma.channelListing.findMany({
  where: { isPublished: true, listingStatus: { notIn: ['ENDED', 'REMOVED'] } },
  select: { productId: true, product: { select: { sku: true, parentId: true } } },
})
const memberships = await prisma.sharedListingMembership.findMany({
  where: { status: 'ACTIVE' },
  select: { productId: true, sku: true },
})

const prodParent = new Map<string, { root: string; sku: string }>()
for (const l of listings) if (l.product) prodParent.set(l.productId, { root: l.product.parentId ?? l.productId, sku: l.product.sku })

const memProdIds = [...new Set(memberships.map((m) => m.productId).filter(Boolean) as string[])]
const memProds = await prisma.product.findMany({ where: { id: { in: memProdIds } }, select: { id: true, sku: true, parentId: true } })
for (const p of memProds) prodParent.set(p.id, { root: p.parentId ?? p.id, sku: p.sku })

const counts = new Map<string, number>()
for (const l of listings) {
  const r = prodParent.get(l.productId)?.root ?? l.productId
  counts.set(r, (counts.get(r) ?? 0) + 1)
}
for (const m of memberships) {
  const r = m.productId ? (prodParent.get(m.productId)?.root ?? m.productId) : 'ORPHAN'
  counts.set(r, (counts.get(r) ?? 0) + 1)
}

const top = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15)
const ids = top.map((t) => t[0])
const names = await prisma.product.findMany({ where: { id: { in: ids } }, select: { id: true, sku: true, name: true } })
const nm = new Map(names.map((n) => [n.id, n]))
console.log('ROWS-PER-PRODUCT (top 15):')
for (const [id, n] of top) console.log(String(n).padStart(5), nm.get(id)?.sku ?? id, '|', (nm.get(id)?.name ?? '').slice(0, 45))
const over50 = [...counts.values()].filter((n) => n > 50).length
console.log('\nproducts with >50 rows:', over50, 'of', counts.size)
await prisma.$disconnect()
