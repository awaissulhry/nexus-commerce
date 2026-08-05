const prisma = (await import('../src/db.js')).default
const rows = await prisma.product.findMany({ where: { sku: { startsWith: 'FFT-SCRATCH-' }, deletedAt: null }, select: { id: true, sku: true, parentId: true } })
for (const r of rows) console.log(`${r.sku} id=${r.id} parent=${r.parentId ?? '-'}`)
await prisma.$disconnect(); process.exit(0)
