import '../src/env.js'
const { default: prisma } = await import('../src/db.js')
const tags = await prisma.tag.findMany({ select: { id: true, name: true, color: true, _count: { select: { products: true, orders: true, assets: true } } } })
console.log('tags:', tags.length)
for (const t of tags.slice(0, 20)) console.log(` ${t.name} ${t.color ?? '(no colour)'} products=${t._count.products} orders=${t._count.orders} assets=${t._count.assets}`)
await prisma.$disconnect(); process.exit(0)
