import '../src/env.js'
const { default: prisma } = await import('../src/db.js')
const P='cmr1b1yxl0000s4rcvopsqv42'
const rows = await prisma.productAiDraft.findMany({ where:{ productId:P, runId:{startsWith:'pes8-d7-'} }, select:{ writeField:true, status:true, decidedBy:true } })
for (const r of rows) console.log(`  ${r.writeField.padEnd(12)} ${r.status.padEnd(9)} by=${r.decidedBy}`)
const t = await prisma.productTranslation.findUnique({ where:{ productId_language:{ productId:P, language:'de' } } })
console.log('de name after reject (must stay empty):', JSON.stringify(t?.name))
await prisma.$disconnect()
