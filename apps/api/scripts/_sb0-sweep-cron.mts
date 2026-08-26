/** NAF.SB.0 — has the fleet-sweep / fleet-council cron ever fired on prod? Read-only. */
import '../src/env.js'
const { default: prisma } = await import('../src/db.js')

for (const key of ['fleet-sweep', 'fleet-council', 'approval-maintenance']) {
  const n = await prisma.cronRun.count({ where: { jobName: key } })
  const last = await prisma.cronRun.findMany({
    where: { jobName: key }, orderBy: { startedAt: 'desc' }, take: 3,
    select: { startedAt: true, finishedAt: true, status: true, errorMessage: true, outputSummary: true },
  })
  console.log(`\n=== ${key} === runs=${n}`)
  for (const r of last)
    console.log(`  ${r.startedAt.toISOString()} ${r.status} ${(r.outputSummary ?? r.errorMessage ?? '').slice(0, 110)}`)
}

// What DID run overnight, so we know the cron host is alive at all.
const recent = await prisma.cronRun.groupBy({
  by: ['jobName'],
  where: { startedAt: { gte: new Date(Date.now() - 24 * 3600 * 1000) } },
  _count: { _all: true },
})
console.log(`\n=== distinct cron jobs that ran in the last 24h: ${recent.length} ===`)
console.log(recent.map((r) => `${r.jobName}=${r._count._all}`).sort().join(' · '))

await prisma.$disconnect()
