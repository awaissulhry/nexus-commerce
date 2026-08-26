import '../src/env.js'
const { default: prisma } = await import('../src/db.js')
const previews = await prisma.agentRun.findMany({
  where: { mode: 'preview' },
  orderBy: { createdAt: 'desc' },
  take: 3,
  select: { id: true, agentKey: true, ok: true, findingCount: true, costUSD: true, errorMessage: true, createdAt: true },
})
console.log('PREVIEW RUNS:', JSON.stringify(previews, null, 2))
const since = new Date(Date.now() - 20 * 60_000)
console.log('findings written since preview:', await prisma.agentFinding.count({ where: { createdAt: { gte: since } } }))
console.log('revisions:', await prisma.agentCharterRevision.count())
console.log('audit rows:', await prisma.agentControlAudit.count())
await prisma.$disconnect()
