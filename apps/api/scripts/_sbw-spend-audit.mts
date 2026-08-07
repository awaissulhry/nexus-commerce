import '../src/env.js'
const { default: prisma } = await import('../src/db.js')
const crons = await prisma.cronRun.findMany({
  where: { jobName: { in: ['fleet-sweep', 'fleet-council'] } },
  orderBy: { startedAt: 'desc' }, take: 8,
  select: { jobName: true, startedAt: true, status: true, outputSummary: true },
})
console.log('CRON RUNS', crons.length)
for (const c of crons) console.log(' ', c.jobName, c.startedAt.toISOString().slice(0,16), c.status, '|', (c.outputSummary ?? '').slice(0, 130))
const spend = await prisma.agentRun.aggregate({
  where: { mode: { not: null } }, _sum: { costUSD: true }, _count: { _all: true },
})
const last24 = await prisma.agentRun.aggregate({
  where: { mode: { not: null }, createdAt: { gte: new Date(Date.now() - 864e5) } },
  _sum: { costUSD: true }, _count: { _all: true },
})
console.log('\nLIFETIME fleet runs:', spend._count._all, 'cost $' + Number(spend._sum.costUSD ?? 0).toFixed(4))
console.log('LAST 24H fleet runs:', last24._count._all, 'cost $' + Number(last24._sum.costUSD ?? 0).toFixed(4))
const on = await prisma.agentCharter.findMany({
  where: { OR: [{ enabled: true }, { autonomyLevel: { not: 'OFF' } }] },
  select: { key: true, enabled: true, autonomyLevel: true },
})
console.log('\nANY CHARTER NOT OFF:', on.length === 0 ? 'none — the whole fleet is dark' : JSON.stringify(on))
await prisma.$disconnect()
