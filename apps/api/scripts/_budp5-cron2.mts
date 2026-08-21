import '../src/env.js'
const { default: prisma } = await import('../src/db.js')
const runs = await prisma.cronRun.findMany({ where: { jobName: 'advertising-rule-evaluator' }, orderBy: { startedAt: 'desc' }, take: 6, select: { startedAt: true, status: true, outputSummary: true, errorMessage: true } })
console.log('advertising-rule-evaluator last 6 runs:')
for (const c of runs) console.log(`  ${c.startedAt.toISOString()} ${c.status} ${String(c.outputSummary ?? c.errorMessage ?? '').slice(0,150)}`)
console.log(`DB now = ${(await prisma.$queryRawUnsafe<Array<{now:Date}>>('SELECT now() as now'))[0].now.toISOString()}`)
await prisma.$disconnect()
