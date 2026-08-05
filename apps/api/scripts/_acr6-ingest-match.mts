/**
 * ACR.6 — applyTargetMetrics exists and is correct. So why is AdTarget.spendCents zero?
 * Two candidates: (a) the ingest never runs, (b) it runs but externalTargetId never matches.
 * READ-ONLY.
 */
import '../src/env.js'
const { default: prisma } = await import('../src/db.js')

const since = new Date(); since.setUTCDate(since.getUTCDate() - 30)

// (b) — does the join key even line up?
const daily = await prisma.amazonAdsDailyPerformance.findMany({
  where: { entityType: 'AD_TARGET', date: { gte: since } },
  select: { entityId: true, localEntityId: true },
  take: 4000,
})
const extIds = [...new Set(daily.map((d) => d.entityId).filter(Boolean))]
const localIds = [...new Set(daily.map((d) => d.localEntityId).filter(Boolean))] as string[]
console.log(`\nAD_TARGET daily rows sampled: ${daily.length}`)
console.log(`  distinct entityId (Amazon's id): ${extIds.length}`)
console.log(`  distinct localEntityId:          ${localIds.length}`)

const matchedByExt = await prisma.adTarget.count({ where: { externalTargetId: { in: extIds.slice(0, 2000) } } })
console.log(`\n  AdTarget rows matching those entityIds via externalTargetId: ${matchedByExt}  ← what applyTargetMetrics joins on`)
if (localIds.length) {
  const matchedByLocal = await prisma.adTarget.count({ where: { id: { in: localIds.slice(0, 2000) } } })
  console.log(`  AdTarget rows matching localEntityId via id:                 ${matchedByLocal}`)
}

const withExt = await prisma.adTarget.count({ where: { externalTargetId: { not: null } } })
const total = await prisma.adTarget.count()
console.log(`\n  AdTarget: ${total} rows, ${withExt} carry an externalTargetId`)

const sampleDaily = extIds.slice(0, 3)
const sampleTargets = await prisma.adTarget.findMany({ where: { externalTargetId: { not: null } }, select: { externalTargetId: true }, take: 3 })
console.log(`\n  sample daily entityId:      ${sampleDaily.join(', ')}`)
console.log(`  sample AdTarget externalId: ${sampleTargets.map((t) => t.externalTargetId).join(', ')}`)

// (a) — has the ingest run at all?
const runs = await prisma.cronRun.findMany({
  where: { job: { contains: 'metric', mode: 'insensitive' } },
  orderBy: { startedAt: 'desc' }, take: 5,
  select: { job: true, startedAt: true, status: true, summary: true },
}).catch(() => [])
console.log(`\nrecent cron runs matching "metric": ${runs.length}`)
for (const r of runs) console.log(`  ${r.startedAt.toISOString()}  ${r.job}  ${r.status}  ${String(r.summary ?? '').slice(0, 90)}`)

await prisma.$disconnect()
