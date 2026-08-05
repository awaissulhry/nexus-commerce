const { default: prisma } = await import('../src/db.js')
const g = await prisma.product.findMany({ where: { sku: { contains: 'GALE' }, parentId: null }, select: { sku: true, masterSku: true } })
for (const p of g) console.log(`${p.sku}  masterSku=${p.masterSku ?? 'NULL'}`)
// how many products overall have masterSku set?
const withMaster = await prisma.product.count({ where: { masterSku: { not: null } } })
const total = await prisma.product.count()
console.log(`\nproducts with masterSku set: ${withMaster}/${total}`)
await prisma.$disconnect()
