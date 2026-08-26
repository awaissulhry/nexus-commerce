import '../src/env.js'
const { default: prisma } = await import('../src/db.js')
const rows = await prisma.agentCharter.findMany({ select: { key: true, name: true, enabled: true }, orderBy: { key: 'asc' } })
for (const r of rows) console.log(' ', r.enabled ? 'ON ' : 'off', r.key, '—', r.name)
await prisma.$disconnect()
