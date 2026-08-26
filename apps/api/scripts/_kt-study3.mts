/** KT part 3 — SQP ingest health per week. READ-ONLY. */
import '../src/env.js'
const { default: prisma } = await import('../src/db.js')
const rows = await prisma.searchQueryPerformance.groupBy({
  by: ['startDate', 'marketplace'],
  _count: { _all: true },
  orderBy: [{ startDate: 'desc' }, { marketplace: 'asc' }],
})
const byWeek = new Map<string, Record<string, number>>()
for (const r of rows) {
  const k = r.startDate.toISOString().slice(0, 10)
  const e = byWeek.get(k) ?? {}
  e[r.marketplace] = r._count._all
  byWeek.set(k, e)
}
console.log('\nWEEK          IT     DE     ES     FR    TOTAL')
for (const [w, m] of byWeek) {
  const t = Object.values(m).reduce((a, b) => a + b, 0)
  console.log(`${w}  ${String(m.IT ?? 0).padStart(5)}  ${String(m.DE ?? 0).padStart(5)}  ${String(m.ES ?? 0).padStart(5)}  ${String(m.FR ?? 0).padStart(5)}  ${String(t).padStart(6)}`)
}
const cron = await prisma.cronRun.findMany({
  where: { name: 'sqp-ingest' }, orderBy: { startedAt: 'desc' }, take: 8,
  select: { startedAt: true, status: true, error: true, durationMs: true },
}).catch(() => [])
console.log('\nsqp-ingest cron — last runs:')
for (const c of cron) console.log(`  ${c.startedAt.toISOString().slice(0, 16)}  ${c.status}  ${c.durationMs ?? '?'}ms  ${c.error ?? ''}`)
if (!cron.length) console.log('  (no CronRun rows found for sqp-ingest)')
await prisma.$disconnect()
