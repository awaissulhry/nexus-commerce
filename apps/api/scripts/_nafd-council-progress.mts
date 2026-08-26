import '../src/env.js'
const { default: prisma } = await import('../src/db.js')
const since = new Date(Date.now() - 20 * 60_000)
const runs = await prisma.agentRun.findMany({
  where: { createdAt: { gte: since }, mode: { not: null } },
  select: { id: true, agentKey: true, status: true, ok: true, costUSD: true, latencyMs: true, errorMessage: true, createdAt: true, orchestrationId: true },
  orderBy: { createdAt: 'asc' },
})
console.log(JSON.stringify(runs, null, 2))
const plans = await prisma.agentPlan.findMany({
  where: { createdAt: { gte: since } },
  select: { id: true, status: true, criticVerdict: true, headline: true },
})
console.log('plans:', JSON.stringify(plans))
await prisma.$disconnect()
