import '../src/env.js'
const { default: prisma } = await import('../src/db.js')
const gale = await prisma.product.findFirst({ where: { sku: 'GALE-JACKET' }, select: { id: true, totalStock: true } })
const kids = await prisma.product.findMany({ where: { parentId: gale!.id }, select: { id: true } })
const ids = [gale!.id, ...kids.map((k) => k.id)]
const rows = await prisma.stockLevel.groupBy({ by: ['locationId'], where: { productId: { in: ids } }, _sum: { quantity: true } })
const locs = await prisma.stockLocation.findMany({ where: { id: { in: rows.map((r) => r.locationId) } }, select: { id: true, type: true, name: true, code: true } })
console.log('GALE own totalStock', gale!.totalStock, '| children', kids.length)
for (const r of rows) { const l = locs.find((x) => x.id === r.locationId); console.log(`  ${l?.type}  ${l?.code ?? l?.name}  qty=${r._sum.quantity}`) }
const types = await prisma.stockLocation.groupBy({ by: ['type'], _count: true }); console.log('location types:', types.map((t) => `${t.type}:${t._count}`).join(' '))
await prisma.$disconnect(); process.exit(0)
