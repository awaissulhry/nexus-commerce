import '../src/env.js'
const { default: prisma } = await import('../src/db.js')
const p = await prisma.product.findFirst({ where: { sku: 'AIREON' }, select: { id: true, description: true } })
console.log('AIREON description now:', JSON.stringify(p?.description))
console.log('leftover verification drafts:', await prisma.productAiDraft.count({ where: { runId: { startsWith: 'pes8-verify-' } } }))
console.log('total drafts in table:', await prisma.productAiDraft.count())
await prisma.$disconnect()
