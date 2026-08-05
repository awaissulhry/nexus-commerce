/** READ-ONLY: is "pool intends 0/30/43" actually correct for the stuck SKUs? */
const { default: prisma } = await import('../src/db.js')
for (const sku of ['VENTRA-JACKET-L-YELLOW-MEN', 'xavia-knee-slider-white', 'normal-knee-slider-yellow', 'WATERPROOF-OVERJACKET-BLACK-MEN-XXL']) {
  const p = await prisma.product.findFirst({
    where: { sku },
    select: {
      id: true, sku: true, totalStock: true,
      stockLevels: { where: { location: { type: 'WAREHOUSE' } }, select: { quantity: true, reserved: true, available: true, location: { select: { code: true, syncRoutes: true } } } },
    },
  })
  if (!p) { console.log(`${sku}: NOT FOUND`); continue }
  const members = await prisma.sharedListingMembership.findMany({
    where: { productId: p.id },
    select: { itemId: true, sku: true, status: true, followPool: true, stockBuffer: true, lastQtyPushed: true },
  })
  console.log(`\n${p.sku} totalStock=${p.totalStock}`)
  for (const s of p.stockLevels) console.log(`  ${s.location?.code} qty=${s.quantity} reserved=${s.reserved} avail=${s.available} routes=${JSON.stringify(s.location?.syncRoutes)}`)
  for (const m of members) console.log(`  member ${m.sku}@${m.itemId} ${m.status} followPool=${m.followPool} buffer=${m.stockBuffer} lastPushed=${m.lastQtyPushed}`)
}
await prisma.$disconnect()
