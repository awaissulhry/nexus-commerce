import '../src/env.js'
const { default: prisma } = await import('../src/db.js')
const masters = await prisma.product.findMany({ where: { sku: { in: ['GALE-JACKET','AIREON','VENTRA-JACKET','IT-MOSS-JACKET','xavia-knee-slider'] } }, select: { sku: true, name: true } })
for (const m of masters) {
  const words = m.name.split(/\s+/).filter(w => w.length > 3)
  const nonSkuWord = words.find(w => !m.sku.toUpperCase().includes(w.toUpperCase()))
  console.log(`sku=${m.sku}  name="${m.name}"  → search term "${nonSkuWord}" matches product filter (name) but NOT export filter (sku only)`)
}
await prisma.$disconnect()
