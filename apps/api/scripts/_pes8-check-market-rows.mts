import '../src/env.js'
const { default: prisma } = await import('../src/db.js')
const rows = await prisma.productAiDraft.findMany({ where: { status: 'pending' }, select: { columnKey: true, market: true, writeField: true } })
for (const r of rows) console.log(`  ${r.writeField.padEnd(16)} market=${r.market}`)
await prisma.$disconnect()
