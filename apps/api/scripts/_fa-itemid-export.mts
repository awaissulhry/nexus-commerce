const { default: prisma } = await import('../src/db.js')
const mems = await prisma.sharedListingMembership.findMany({ select: { itemId: true, sku: true, productId: true }, take: 2000 })
const ids = [...new Set(mems.map(m => m.itemId))]
console.log('distinct itemIds:', ids.length, 'sample:', ids.slice(0,5))
let hits = 0
for (const id of ids.slice(0, 25)) {
  const c = await prisma.product.count({ where: { OR: [{ name: { contains: id, mode: 'insensitive' } }, { sku: { contains: id, mode: 'insensitive' } }] } })
  const skuHit = await prisma.product.count({ where: { sku: { contains: id, mode: 'insensitive' } } })
  if (c) hits++
  console.log(id, 'name/sku matches:', c, 'skuOnly:', skuHit)
}
console.log('itemIds resolvable via product name/sku:', hits, '/25')
// how many rows would the grid show for one itemId
const sample = ids[0]
const n = mems.filter(m => m.itemId === sample).length
console.log('grid rows for', sample, '=', n, 'memberships')
await prisma.$disconnect()
