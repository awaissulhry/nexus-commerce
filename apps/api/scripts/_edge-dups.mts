/** READ-ONLY: are the naming-inconsistent singletons actually the same product? */
const { default: prisma } = await import('../src/db.js')
const groups = [
  ['AIRMESH', ['AIR-MESH-JACKET-MEN','AIRMESH-JACKET','AIRMESH-JACKET-ALT1']],
  ['OVERJACKET', ['WATERPROOF-OVERJACKET-ALT1','WATERPROOF-OVERJACKET-BLACK-MEN','1-OVERJACKET-BLACK-MEN']],
]
for (const [label, skus] of groups) {
  console.log(`\n=== ${label} ===`)
  for (const sku of skus as string[]) {
    const p = await prisma.product.findFirst({ where: { sku }, select: { id: true, sku: true, name: true } })
    if (!p) { console.log(`  ${sku}: NOT FOUND`); continue }
    const variants = await prisma.product.count({ where: { parentId: p.id } })
    const cls = await prisma.channelListing.groupBy({ by: ['channel'], where: { productId: { in: [p.id] } }, _count: { _all: true } })
    const img = await prisma.productImage.findFirst({ where: { productId: p.id }, select: { url: true }, orderBy: { sortOrder: 'asc' } })
    console.log(`  ${sku}`)
    console.log(`     name="${(p.name??'').slice(0,50)}"`)
    console.log(`     variants=${variants} listings=${JSON.stringify(cls.map(c=>c.channel+':'+c._count._all))} img=${img?.url?.slice(-30) ?? 'none'}`)
  }
}
await prisma.$disconnect()
