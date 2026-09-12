import '../src/env.js'
const { default: prisma } = await import('../src/db.js')
const P = 'cmr1b1yxl0000s4rcvopsqv42'
const p = await prisma.product.findUnique({ where: { id: P }, select: { categoryAttributes: true } })
const attrs = (p?.categoryAttributes as Record<string, unknown> | null) ?? {}
console.log('material in the catalogue now:', JSON.stringify(attrs.material))
const d = await prisma.productAiDraft.findFirst({ where: { writeField: 'attr_material', productId: P }, orderBy: { createdAt: 'desc' } })
console.log('draft status:', d?.status, ' decidedBy:', d?.decidedBy)
await prisma.$disconnect()
