/** READ-ONLY: what would hourly cost? duplicate-instance check + run-duration profile. */
const { default: prisma } = await import('../src/db.js')

// Are crons firing twice (multiple API instances)? Group same-job runs by minute.
const since = new Date(Date.now() - 3 * 24 * 3600e3)
const runs = await prisma.cronRun.findMany({
  where: { startedAt: { gte: since }, jobName: { in: ['sync-drift-detection', 'ebay-readback', 'amazon-qty-readback', 'outbound-queue-janitor'] } },
  select: { jobName: true, startedAt: true, finishedAt: true, status: true },
  orderBy: { startedAt: 'asc' },
})
const slots = new Map<string, number>()
for (const r of runs) slots.set(`${r.jobName}@${r.startedAt.toISOString().slice(0, 16)}`, (slots.get(`${r.jobName}@${r.startedAt.toISOString().slice(0, 16)}`) ?? 0) + 1)
const dupBy = new Map<string, { slots: number; dup: number }>()
for (const [k, n] of slots) {
  const job = k.split('@')[0]
  const e = dupBy.get(job) ?? { slots: 0, dup: 0 }
  e.slots++
  if (n > 1) e.dup++
  dupBy.set(job, e)
}
console.log('--- duplicate-fire check (last 3d) ---')
for (const [job, v] of dupBy) console.log(`  ${job.padEnd(24)} ${v.slots} scheduled slots · ${v.dup} fired more than once`)

// Duration profile of the readback specifically.
const rb = await prisma.cronRun.findMany({
  where: { jobName: 'amazon-qty-readback', finishedAt: { not: null } },
  select: { startedAt: true, finishedAt: true, outputSummary: true },
  orderBy: { startedAt: 'desc' }, take: 20,
})
const durs = rb.map((r) => (r.finishedAt!.getTime() - r.startedAt.getTime()) / 1000).sort((a, b) => a - b)
if (durs.length) {
  console.log(`\nreadback duration over ${durs.length} runs: min ${durs[0]}s  median ${durs[Math.floor(durs.length / 2)]}s  max ${durs[durs.length - 1]}s`)
}

// How much SyncHealthLog volume already exists (retention concern if 24x more runs)?
const total = await prisma.syncHealthLog.count()
const rbLogs = await prisma.syncHealthLog.count({ where: { conflictType: 'CHANNEL_QTY_READBACK' } })
console.log(`\nSyncHealthLog rows total: ${total} (CHANNEL_QTY_READBACK: ${rbLogs})`)
await prisma.$disconnect()
