/** READ-ONLY: label-guard cron run history. */
const { default: prisma } = await import('../src/db.js')
const runs = await prisma.cronRun.findMany({
  where: { jobName: 'ebay-label-guard' },
  orderBy: { startedAt: 'desc' }, take: 5,
  select: { startedAt: true, status: true, outputSummary: true, errorMessage: true },
})
console.log('RUNS:', runs.length)
for (const r of runs) console.log(`  ${r.startedAt.toISOString()} ${r.status} ${String(r.outputSummary ?? r.errorMessage ?? '').slice(0, 140)}`)
await prisma.$disconnect()
