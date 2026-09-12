import '../src/env.js'
const { default: prisma } = await import('../src/db.js')
const P = 'cmr1b1yxl0000s4rcvopsqv42'
const p = await prisma.product.findUnique({ where: { id: P }, select: { description: true } })
console.log('4. description in the catalogue now:', JSON.stringify((p?.description ?? '').slice(0, 80)))
const a = await prisma.auditLog.findFirst({ where: { entityType: 'Product', entityId: P, action: 'ai-draft.approve' }, orderBy: { createdAt: 'desc' } })
console.log('5. ai-draft.approve audit:', a ? JSON.stringify(a.metadata).slice(0, 160) : 'MISSING')
const b = await prisma.auditLog.findFirst({ where: { entityType: 'Product', entityId: P, action: 'update' }, orderBy: { createdAt: 'desc' } })
console.log('5b. bulk PATCH audit present:', !!b)
await prisma.$disconnect()
