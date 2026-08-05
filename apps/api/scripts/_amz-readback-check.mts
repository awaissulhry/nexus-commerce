const { default: prisma } = await import('../src/db.js')
const names = await prisma.cronRun.groupBy({ by: ['jobName'], _max: { startedAt: true }, _count: true })
const amz = names.filter(n => /amazon|qty|quantity|readback|reconcile|publish-health/i.test(n.jobName))
console.log('quantity / amazon / readback-ish jobs:')
for (const n of amz.sort((a,b)=>a.jobName.localeCompare(b.jobName))) {
  console.log(`  ${n.jobName.padEnd(32)} last=${n._max.startedAt?.toISOString() ?? 'never'}  runs=${n._count}`)
}
const latest = await prisma.cronRun.findMany({
  where: { jobName: { contains: 'amazon', mode: 'insensitive' } },
  orderBy: { startedAt: 'desc' }, take: 3,
  select: { jobName: true, startedAt: true, status: true, outputSummary: true },
})
console.log('\nlatest amazon-ish runs:')
for (const r of latest) console.log(`  ${r.startedAt.toISOString()} ${r.jobName} ${r.status} ${JSON.stringify(r.outputSummary)?.slice(0,160)}`)
await prisma.$disconnect()
