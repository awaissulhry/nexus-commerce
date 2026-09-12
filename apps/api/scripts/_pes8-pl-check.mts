import '../src/env.js'
const { default: prisma } = await import('../src/db.js')
const rows = await prisma.marketplace.findMany({ where: { isActive: true, code: { in: ['PL','DE','IT'] } }, select: { channel: true, code: true, isActive: true } })
for (const r of rows) console.log(`  ${r.channel}:${r.code}`)
await prisma.$disconnect()
