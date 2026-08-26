import '../src/env.js'
const { default: prisma } = await import('../src/db.js')
const auditor = await prisma.agentCharter.findFirst({ where: { key: 'fleet-auditor' }, select: { key: true } })
console.log('fleet-auditor charter row:', auditor ? 'EXISTS' : 'MISSING')
const kinds = await prisma.agentFinding.groupBy({ by: ['charterKey', 'kind'], _count: true })
console.log('findings by charter/kind:', JSON.stringify(kinds, null, 1))
const plan = await prisma.agentPlan.findFirst({
  orderBy: { createdAt: 'desc' },
  select: { id:true, status:true, criticVerdict:true, headline:true, items:true, approvalIds:true, droppedItems:true, narrative:true },
})
console.log('the one plan:', plan?.status, plan?.criticVerdict)
console.log('  headline:', plan?.headline)
console.log('  items:', Array.isArray(plan?.items) ? (plan!.items as unknown[]).length : '?')
console.log('  dropped:', Array.isArray(plan?.droppedItems) ? (plan!.droppedItems as unknown[]).length : '?')
console.log('  approvalIds:', JSON.stringify(plan?.approvalIds))
console.log('  narrative chars:', (plan?.narrative ?? '').length)
await prisma.$disconnect()
