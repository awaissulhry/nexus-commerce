/** READ-ONLY: pool truth for the live-mismatch VENTRA variants. */
const { default: prisma } = await import('../src/db.js')
for (const sku of ['VENTRA-JACKET-4XL-YELLOW-MEN', 'VENTRA-JACKET-3XL-RED-MEN', 'VENTRA-JACKET-3XL-YELLOW-MEN']) {
  const p = await prisma.product.findFirst({
    where: { sku },
    select: { totalStock: true, stockLevels: { where: { location: { type: 'WAREHOUSE' } }, select: { quantity: true, reserved: true, available: true } } },
  })
  console.log(sku, 'totalStock=' + p?.totalStock, JSON.stringify(p?.stockLevels))
}
await prisma.$disconnect()
