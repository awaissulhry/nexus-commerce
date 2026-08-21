import '../src/env.js'
const { default: prisma } = await import('../src/db.js')
const runs = await prisma.cronRun.findMany({ where: { startedAt: { gte: new Date(Date.now() - 100*60e3) } }, orderBy: { startedAt: 'desc' }, take: 40, select: { jobName: true, startedAt: true, finishedAt: true, status: true, outputSummary: true } })
console.log('cron runs in the last 100 min that overlap 19:19-19:23:')
for (const c of runs) {
  const s = c.startedAt.getTime(), f = (c.finishedAt ?? c.startedAt).getTime()
  const lo = Date.parse('2026-08-21T19:19:00Z'), hi = Date.parse('2026-08-21T19:23:30Z')
  if (s <= hi && f >= lo) console.log(`  ${c.startedAt.toISOString()} -> ${c.finishedAt?.toISOString() ?? '?'} ${c.jobName} ${c.status} ${String(c.outputSummary ?? '').slice(0,140)}`)
}
await prisma.$disconnect()
