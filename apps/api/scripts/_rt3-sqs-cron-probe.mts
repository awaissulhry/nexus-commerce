/** READ-ONLY: what has amazon-sqs-poll been reporting? */
const { default: prisma } = await import('../src/db.js')
const runs = await prisma.cronRun.findMany({
  where: { jobName: 'amazon-sqs-poll' },
  orderBy: { startedAt: 'desc' },
  take: 12,
  select: { startedAt: true, status: true, outputSummary: true, errorMessage: true },
})
for (const r of runs) {
  console.log(`${r.startedAt.toISOString().slice(5, 19)} ${r.status} ${r.outputSummary ?? ''} ${r.errorMessage?.slice(0, 120) ?? ''}`)
}
const agg = await prisma.cronRun.groupBy({
  by: ['status'],
  where: { jobName: 'amazon-sqs-poll', startedAt: { gte: new Date(Date.now() - 24 * 3600e3) } },
  _count: { _all: true },
})
console.log('24h:', JSON.stringify(agg.map((a) => `${a.status}=${a._count._all}`)))
await prisma.$disconnect()
process.exit(0)
