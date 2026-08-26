import '../src/env.js'
const { default: prisma } = await import('../src/db.js')
const orphanMarked = await prisma.agentRun.count({ where: { haltedReason: { startsWith: 'orphaned' } } })
const stuck = await prisma.agentRun.findMany({ where: { status: 'running', mode: { not: null } }, select: { id: true, agentKey: true, createdAt: true } })
console.log('rows marked orphaned:', orphanMarked, '· currently stuck running:', JSON.stringify(stuck))
await prisma.$disconnect()
