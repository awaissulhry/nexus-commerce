import '../src/env.js'
const { default: prisma } = await import('../src/db.js')
const n = await prisma.automationRule.count({ where: { domain: 'advertising' } })
const names = await prisma.automationRule.findMany({ where: { domain: 'advertising' }, select: { name: true, createdAt: true } })
console.log(`advertising rules on prod: ${n}`)
for (const r of names) console.log(`  "${r.name}" ${r.createdAt.toISOString()}`)
await prisma.$disconnect()
