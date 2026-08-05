/** READ-ONLY: image availability per pool. */
const { default: prisma } = await import('../src/db.js')
for (const sku of ['VENTRA-JACKET', 'REGAL-JACKET', 'WATERPROOF-OVERJACKET-BLACK-MEN', '3K-HP05-BH9I']) {
  const p = await prisma.product.findFirst({ where: { sku, deletedAt: null }, select: { id: true, children: { select: { id: true, sku: true } } } })
  if (!p) { console.log(sku, 'ABSENT'); continue }
  const master = await prisma.productImage.count({ where: { productId: p.id } })
  const childImgs = await prisma.productImage.count({ where: { productId: { in: p.children.map((c) => c.id) } } })
  const listingImgs = await prisma.listingImage.count({ where: { productId: { in: [p.id, ...p.children.map((c) => c.id)] } } })
  console.log(`${sku}: masterImgs=${master} childImgs=${childImgs} ebayListingImgs=${listingImgs} children=${p.children.length}`)
}
await prisma.$disconnect()
