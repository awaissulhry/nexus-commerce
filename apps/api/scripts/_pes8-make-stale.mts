import '../src/env.js'
const { default: prisma } = await import('../src/db.js')
const P = 'cmr1b1yxl0000s4rcvopsqv42'
const p = await prisma.product.findUnique({ where: { id: P }, select: { categoryAttributes: true } })
const attrs = (p?.categoryAttributes as Record<string, unknown> | null) ?? {}
await prisma.product.update({ where: { id: P }, data: { categoryAttributes: { ...attrs, material: 'Leather' } } })
console.log('material set to Leather (an operator edit under the draft)')
await prisma.$disconnect()
