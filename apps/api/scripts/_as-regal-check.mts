/** READ-ONLY: did the already-CANCELLED REGAL order deduct stock at 11:55? */
const { default: prisma } = await import('../src/db.js')
const p = await prisma.product.findFirst({ where: { sku: 'REGAL-JACKET-L-BLACK-WOMEN' }, select: { id: true, sku: true, totalStock: true } })
console.log('product:', p?.sku, 'totalStock=', p?.totalStock)
if (p) {
  const mv = await prisma.stockMovement.findMany({ where: { productId: p.id, createdAt: { gte: new Date(Date.now() - 6 * 3600e3) } }, orderBy: { createdAt: 'desc' }, take: 6, select: { createdAt: true, change: true, reason: true, balanceAfter: true, notes: true } })
  console.log(`movements last 6h: ${mv.length}`)
  for (const m of mv) console.log(`  ${m.createdAt.toISOString().slice(11, 19)} ${m.reason} change=${m.change} after=${m.balanceAfter} ${(m.notes ?? '').slice(0, 60)}`)
}
const anyOrderPlaced = await prisma.stockMovement.findMany({ where: { reason: 'ORDER_PLACED', createdAt: { gte: new Date(Date.now() - 6 * 3600e3) } }, take: 6, select: { createdAt: true, change: true, productId: true, notes: true } })
console.log(`ORDER_PLACED movements last 6h: ${anyOrderPlaced.length}`)
for (const m of anyOrderPlaced) console.log(`  ${m.createdAt.toISOString().slice(11, 19)} change=${m.change} ${(m.notes ?? '').slice(0, 70)}`)
await prisma.$disconnect()
process.exit(0)
