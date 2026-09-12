import '../src/env.js'
const { default: prisma } = await import('../src/db.js')
const P='cmr1b1yxl0000s4rcvopsqv42'
const p = await prisma.product.findUnique({ where:{id:P}, select:{name:true} })
console.log('name unchanged by reject:', JSON.stringify((p?.name ?? '').slice(0,55)))
const rows = await prisma.productAiDraft.groupBy({ by:['status'], _count:{status:true}, where:{ runId:{startsWith:'pes8-'} } })
console.log('draft statuses:', JSON.stringify(rows.map(r=>({[r.status]:r._count.status}))))
await prisma.$disconnect()
