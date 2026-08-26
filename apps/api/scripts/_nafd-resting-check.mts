import '../src/env.js'
const { default: prisma } = await import('../src/db.js')
const charters = await prisma.agentCharter.findMany({
  select: { key: true, enabled: true, autonomyLevel: true },
  orderBy: { key: 'asc' },
})
console.log(JSON.stringify(charters))
const pend = await prisma.agentApproval.count({
  where: { status: 'pending', toolName: { in: ['create-negative-keyword', 'graduate-keyword', 'set-target-bid'] } },
})
console.log('pending fleet approvals:', pend)
const outbound = await prisma.outboundSyncQueue.count({
  where: { syncType: { startsWith: 'AD_' }, createdAt: { gte: new Date('2026-08-06T19:53:00Z') } },
})
console.log('outbound AD_* rows since 19:53Z:', outbound)
await prisma.$disconnect()
