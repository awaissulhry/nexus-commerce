import '../src/env.js'
const { default: prisma } = await import('../src/db.js')
const rows = await prisma.product.findMany({
  where: { OR: [{ sku: { startsWith: 'XAV' } }, { brand: { equals: 'XAVIA', mode: 'insensitive' } }] },
  select: { id: true, sku: true, name: true, brand: true, productType: true, isParent: true, parentId: true, status: true },
  orderBy: { sku: 'asc' },
  take: 40,
})
console.log('matches:', rows.length)
for (const r of rows) {
  console.log(`  ${r.sku.padEnd(22)} type=${String(r.productType).padEnd(12)} parent=${r.isParent} pid=${r.parentId ? 'child' : '-'} ${r.status} :: ${r.id}`)
}
await prisma.$disconnect()
