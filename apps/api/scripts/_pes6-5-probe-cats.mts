import prisma from '../src/db.js'
const [cats, active, links, closure, prodTypes] = await Promise.all([
  prisma.category.count(),
  prisma.category.count({ where: { isActive: true } }),
  prisma.productCategory.count(),
  prisma.categoryClosure.count(),
  prisma.product.groupBy({ by: ['productType'], _count: { id: true }, orderBy: { _count: { id: 'desc' } }, take: 15 }),
])
console.log('Category rows:', cats, '| isActive:', active)
console.log('ProductCategory rows:', links)
console.log('CategoryClosure rows:', closure)
console.log('\nProduct.productType distribution (the axis in use TODAY):')
for (const p of prodTypes) console.log(`  ${String(p.productType).padEnd(28)} ${p._count.id}`)
const nulls = await prisma.product.count({ where: { productType: null } })
console.log('  (null)'.padEnd(30), nulls)
await prisma.$disconnect()
