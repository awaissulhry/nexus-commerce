import '../src/env.js'
const { default: prisma } = await import('../src/db.js')
const P='cmr1b1yxl0000s4rcvopsqv42'
const p = await prisma.product.findUnique({ where:{id:P}, select:{description:true} })
console.log('catalogue description:', JSON.stringify((p?.description ?? '').slice(0,70)))
const d = await prisma.productAiDraft.findFirst({ where:{productId:P, writeField:'description'}, orderBy:{createdAt:'desc'} })
console.log('draft status:', d?.status, 'decidedBy:', d?.decidedBy)
const a = await prisma.auditLog.findFirst({ where:{entityType:'Product', entityId:P, action:'ai-draft.approve'}, orderBy:{createdAt:'desc'} })
console.log('audit metadata:', JSON.stringify(a?.metadata).slice(0,140))
await prisma.$disconnect()
