import '../src/env.js'
const { default: prisma } = await import('../src/db.js')
const p = await prisma.product.findFirst({ where: { sku: 'WATERPROOF-OVERJACKET-BLACK-MEN' }, select: { id: true } })
const kids = await prisma.product.findMany({ where: { parentId: p!.id }, select: { id: true, sku: true } })
const lv = await prisma.stockLevel.findMany({ where: { productId: { in: [p!.id, ...kids.map(k => k.id)] }, location: { type: 'WAREHOUSE' } }, select: { productId: true, available: true } })
const sum = new Map<string, number>()
for (const l of lv) sum.set(l.productId, (sum.get(l.productId) ?? 0) + l.available)
const masterStock = sum.get(p!.id) ?? 0
const variantStock = kids.reduce((s, k) => s + (sum.get(k.id) ?? 0), 0)
const variantsInStockTrue = kids.filter(k => (sum.get(k.id) ?? 0) > 0).length
console.log('WATERPROOF-OVERJACKET-BLACK-MEN')
console.log('  real children              :', kids.length)
console.log('  master own warehouse stock :', masterStock)
console.log('  sum over real variants     :', variantStock)
console.log('  GRID SHOWS poolTotal       :', masterStock + variantStock, ' (master counted as a variant)')
console.log('  GRID SHOWS variantsInStock :', variantsInStockTrue + (masterStock > 0 ? 1 : 0), '/', kids.length + 1)
console.log('  TRUTH                      :', variantsInStockTrue, '/', kids.length, '=', variantStock, 'u')
await prisma.$disconnect()
