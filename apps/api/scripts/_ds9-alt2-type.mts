/** READ-ONLY: which publisher actually handles GALE-JACKET-ALT2? */
const { default: prisma } = await import('../src/db.js')
const p = await prisma.product.findFirst({
  where: { sku: 'GALE-JACKET-ALT2', deletedAt: null },
  select: { id: true, sku: true, productType: true, parentId: true, ebayItemId: true },
})
console.log('product:', JSON.stringify(p))
if (p) {
  const kids = await prisma.product.findMany({ where: { parentId: p.id, deletedAt: null }, select: { sku: true } })
  console.log('variant children:', kids.length, kids.map(k => k.sku).slice(0, 5))
  const mem = await prisma.sharedListingMembership.findMany({
    where: { parentSku: 'GALE-JACKET-ALT2' }, select: { itemId: true, status: true, marketplace: true }, take: 5,
  })
  console.log('shared memberships:', JSON.stringify(mem))
}
await prisma.$disconnect()
