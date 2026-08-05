/** READ-ONLY: probe 4 — CronRun heartbeats (which crons actually run on prod). */
const { default: prisma } = await import('../src/db.js')
const now = Date.now()
const d3 = new Date(now - 3 * 24 * 3600e3)
const runs = await prisma.cronRun.groupBy({
  by: ['jobName'],
  where: { startedAt: { gte: d3 } },
  _count: { _all: true },
  _max: { startedAt: true },
})
console.log('== CronRun last 3d (prod heartbeats) ==')
for (const r of runs.sort((a, b) => (b._count._all - a._count._all))) {
  const last = r._max.startedAt ? Math.round((now - r._max.startedAt.getTime()) / 60e3) : null
  console.log(`  ${r.jobName}: runs=${r._count._all} lastRunAgoMin=${last}`)
}
await prisma.$disconnect()
process.exit(0)
