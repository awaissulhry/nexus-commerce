/** READ-ONLY: is the quantity READ-BACK loop actually running? Without it the
 *  owner cannot verify what landed on Amazon after a bulk change. */
const { default: prisma } = await import('../src/db.js')
const runs = await prisma.cronRun.findMany({
  where: { jobName: { contains: 'readback', mode: 'insensitive' } },
  orderBy: { startedAt: 'desc' }, take: 5,
  select: { jobName: true, startedAt: true, status: true, outputSummary: true },
})
console.log(`readback cron runs found: ${runs.length}`)
for (const r of runs) console.log(`  ${r.startedAt.toISOString()} ${r.jobName} ${r.status} ${JSON.stringify(r.outputSummary)?.slice(0,120)}`)

const names = await prisma.cronRun.groupBy({ by: ['jobName'], _max: { startedAt: true }, _count: true })
console.log('\nall cron jobs (most recent run):')
for (const n of names.sort((a,b)=> (b._max.startedAt?.getTime()??0)-(a._max.startedAt?.getTime()??0)).slice(0,14)) {
  console.log(`  ${(n._max.startedAt?.toISOString() ?? 'never').padEnd(26)} ${n.jobName} (${n._count} runs)`)
}
console.log(`\nENV NEXUS_QTY_READBACK_MARKETS = ${process.env.NEXUS_QTY_READBACK_MARKETS ?? '(unset locally)'}`)
await prisma.$disconnect()
