/** SQP.3 Phase B verification — read-only. Does the window move, and does the skip see real rows? */
import prisma from '../src/db.js'
import { periodWindow, SQP_LOOKBACK } from '../src/services/advertising/sqp.service.js'
import { partitionRequestSet } from '../src/services/advertising/sqp-async.service.js'

console.log('━━━ 1 · the window this pass now targets ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
console.log('SQP_LOOKBACK =', SQP_LOOKBACK, '(env NEXUS_SQP_LOOKBACK =', process.env.NEXUS_SQP_LOOKBACK ?? 'unset', ')')
for (const lb of [1, 2]) {
  const w = periodWindow('WEEK', new Date(), lb)
  const stored = await prisma.searchQueryPerformance.count({ where: { reportPeriod: 'WEEK', startDate: w.start } })
  console.log(`  lookback ${lb} → week ${w.start.toISOString().slice(0,10)} .. ${w.end.toISOString().slice(0,10)}  · stored rows ${stored}${lb === SQP_LOOKBACK ? '   ← ACTIVE' : ''}`)
}
const newest = await prisma.searchQueryPerformance.aggregate({ _max: { startDate: true } })
console.log('  newest week stored anywhere:', newest._max.startDate?.toISOString().slice(0,10))

console.log('\n━━━ 2 · rowsChanged, and what counts as settled today ━━━━━━━━━━━━━━━━━━━━━━')
const g = await prisma.sqpReportRequest.groupBy({ by: ['status'], _count: { _all: true } })
console.log('  requests by status:', g.map((r) => `${r.status}=${r._count._all}`).join(' '))
const nullChanged = await prisma.sqpReportRequest.count({ where: { status: 'INGESTED', rowsChanged: null } })
const zeroChanged = await prisma.sqpReportRequest.count({ where: { status: 'INGESTED', rowsChanged: 0 } })
console.log(`  INGESTED with rowsChanged NULL (unknown ⇒ will fetch): ${nullChanged}`)
console.log(`  INGESTED with rowsChanged = 0  (settled ⇒ will skip):  ${zeroChanged}`)

console.log('\n━━━ 3 · the partition, against the ACTIVE week and real ASINs ━━━━━━━━━━━━━━')
const win = periodWindow('WEEK', new Date(), SQP_LOOKBACK)
const mkts = await prisma.sqpReportRequest.findMany({ where: { reportPeriod: 'WEEK' }, select: { marketplace: true }, distinct: ['marketplace'] })
for (const { marketplace } of mkts.slice(0, 4)) {
  const asins = (await prisma.sqpReportRequest.findMany({
    where: { marketplace, reportPeriod: 'WEEK' }, select: { asin: true }, distinct: ['asin'], take: 10,
  })).map((r) => r.asin)
  const out = (await prisma.sqpReportRequest.findMany({
    where: { marketplace, reportPeriod: 'WEEK', startDate: win.start, asin: { in: asins }, status: { in: ['PENDING','DONE'] } },
    select: { asin: true },
  })).map((r) => r.asin)
  const set = (await prisma.sqpReportRequest.findMany({
    where: { marketplace, reportPeriod: 'WEEK', startDate: win.start, asin: { in: asins }, status: 'INGESTED', rowsChanged: 0 },
    select: { asin: true },
  })).map((r) => r.asin)
  const p = partitionRequestSet({ asins, outstanding: out, settled: set })
  console.log(`  ${marketplace}: ${asins.length} asins → request ${p.toRequest.length} · outstanding ${p.alreadyOutstanding.length} · settled ${p.alreadySettled.length}`)
}
await prisma.$disconnect()
