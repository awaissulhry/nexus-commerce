const { default: prisma } = await import('../src/db.js')
const ids = ['cmr1b1yxl0000s4rcvopsqv42', 'cmokmy3a40078pm0p1fvnu523', 'cmokmy3bb007bpm0phlfs27ij', 'cmokmy2ym006fpm0pa4raljl7']
const lv = await prisma.stockLevel.findMany({ where: { productId: { in: ids }, location: { type: 'WAREHOUSE' } }, select: { productId: true, available: true, location: { select: { code: true } } } })
console.log('master own WAREHOUSE stock levels:', lv)
for (const id of ids) {
  const kids = await prisma.product.findMany({ where: { parentId: id }, select: { id: true } })
  const kl = await prisma.stockLevel.findMany({ where: { productId: { in: kids.map(k=>k.id) }, location: { type: 'WAREHOUSE' } }, select: { productId: true, available: true } })
  const inStock = new Set(kl.filter(x=>x.available>0).map(x=>x.productId)).size
  const p = await prisma.product.findUnique({ where: { id }, select: { sku: true } })
  console.log(`${p?.sku}: real children=${kids.length}, children with pool>0 = ${inStock}  -> UI would show ${inStock}/${kids.length+1}`)
}
await prisma.$disconnect()
