/** KT part 4 — is the SQP cron alive at all? READ-ONLY. */
import '../src/env.js'
const { default: prisma } = await import('../src/db.js')
const names = await prisma.cronRun.groupBy({ by: ["jobName"], _count: { _all: true }, _max: { startedAt: true } })
const rel = names.filter((n) => /sqp|search|rank|brand|ads/i.test(n.jobName)).sort((a, b) => a.jobName.localeCompare(b.jobName))
console.log('\nCronRun — ads/search related:')
for (const n of rel) console.log(`  ${n.jobName.padEnd(34)} runs=${String(n._count._all).padStart(6)}  last=${n._max.startedAt?.toISOString().slice(0, 16) ?? '—'}`)
console.log(`\ntotal distinct cron names recorded: ${names.length}`)
const newest = [...names].sort((a, b) => (b._max.startedAt?.getTime() ?? 0) - (a._max.startedAt?.getTime() ?? 0)).slice(0, 5)
console.log('most recently active crons (proves the table is live):')
for (const n of newest) console.log(`  ${n.jobName.padEnd(34)} last=${n._max.startedAt?.toISOString().slice(0, 16)}`)
await prisma.$disconnect()
