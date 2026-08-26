import '../src/env.js'
const { default: prisma } = await import('../src/db.js')
for (let i = 0; i < 40; i++) {
  const runs = await prisma.agentRun.findMany({
    where: { agentKey: { in: ['amazon-negative-miner', 'amazon-bid-tuner'] }, createdAt: { gte: new Date(Date.now() - 10 * 60_000) } },
    orderBy: { createdAt: 'desc' },
    select: { id: true, agentKey: true, status: true, ok: true, findingCount: true, costUSD: true, latencyMs: true, haltedReason: true, errorMessage: true },
  })
  const latest = new Map()
  for (const r of runs) if (!latest.has(r.agentKey)) latest.set(r.agentKey, r)
  const vals = [...latest.values()]
  if (vals.length === 2 && vals.every((r) => r.status !== 'running')) {
    console.log('SETTLED:', JSON.stringify(vals, null, 2))
    break
  }
  await new Promise((res) => setTimeout(res, 5000))
}
await prisma.$disconnect()
