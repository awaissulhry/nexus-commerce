/** ACR.2.3 — has the tos-is-ingest cron ever succeeded? READ-ONLY. */
import '../src/env.js'
const { default: prisma } = await import('../src/db.js')
const runs = await prisma.cronRun.findMany({
  where: { jobName: 'tos-is-ingest' },
  orderBy: { startedAt: 'desc' }, take: 12,
  select: { startedAt: true, finishedAt: true, status: true, outputSummary: true, errorMessage: true },
})
console.log(`tos-is-ingest: ${runs.length} recent runs`)
for (const r of runs) {
  const secs = r.finishedAt ? Math.round((r.finishedAt.getTime() - r.startedAt.getTime()) / 1000) : null
  console.log(`  ${r.startedAt.toISOString().slice(0, 19)}  ${String(r.status).padEnd(8)} ${secs != null ? `${secs}s` : '—'}  ${String(r.outputSummary ?? r.errorMessage ?? '').slice(0, 150)}`)
}
await prisma.$disconnect()
