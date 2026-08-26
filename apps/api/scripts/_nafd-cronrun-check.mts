import '../src/env.js'
const { default: prisma } = await import('../src/db.js')
const runs = await prisma.cronRun.findMany({
  where: { jobName: { in: ['fleet-sweep', 'fleet-council'] } },
  orderBy: { startedAt: 'desc' },
  take: 5,
  select: { jobName: true, startedAt: true, status: true, outputSummary: true },
})
console.log(JSON.stringify(runs, null, 2))
await prisma.$disconnect()
