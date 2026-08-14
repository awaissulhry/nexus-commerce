/** SQP.4 — finish collecting, then measure the gate and the reach line, before vs after. */
import prisma from '../src/db.js'
import { periodWindow, SQP_LOOKBACK } from '../src/services/advertising/sqp.service.js'
import { collectSqpReports } from '../src/services/advertising/sqp-async.service.js'
import { chooseViewPeriod, KT_MARKETS } from '../src/services/advertising/keyword-tracker.service.js'
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const win = periodWindow('WEEK', new Date(), SQP_LOOKBACK)

for (let i = 0; i < 40; i++) {
  const c = await collectSqpReports({ limit: 60 })
  if (c.ingested) console.log(`  ingested=${c.ingested} rows=${c.rowsUpserted} pending=${c.stillPending}`)
  if (!c.stillPending) break
  await sleep(20_000)
}
const left = await prisma.sqpReportRequest.count({ where: { status: { in: ['PENDING', 'DONE'] } } })
console.log(`outstanding: ${left}`)

console.log('\n━━━ per-report yield, aimed vs nightly, on the SAME week ━━━━━━━━━━━━━━━━━')
const reqs = await prisma.sqpReportRequest.findMany({
  where: { reportPeriod: 'WEEK', startDate: win.start }, select: { marketplace: true, asin: true, rowsParsed: true, requestedAt: true },
})
// the aimed batch is everything requested after 15:00 UTC today
const CUT = Date.parse(new Date().toISOString().slice(0, 10) + 'T15:00:00Z')
for (const m of KT_MARKETS) {
  const mine = reqs.filter((r) => r.marketplace === m)
  const aimed = mine.filter((r) => +r.requestedAt >= CUT), nightly = mine.filter((r) => +r.requestedAt < CUT)
  const s = (x: typeof mine) => x.reduce((a, r) => a + (r.rowsParsed ?? 0), 0)
  console.log(`  ${m}: aimed ${aimed.length} reports → ${s(aimed)} rows (${aimed.length ? (s(aimed)/aimed.length).toFixed(1) : '—'}/report)  ·  nightly ${nightly.length} → ${s(nightly)} rows (${nightly.length ? (s(nightly)/nightly.length).toFixed(1) : '—'}/report)`)
}

console.log('\n━━━ the gate, and the operator-visible reach line ━━━━━━━━━━━━━━━━━━━━━━━━')
const g = await prisma.searchQueryPerformance.groupBy({
  by: ['startDate', 'marketplace'], where: { reportPeriod: 'WEEK' }, _count: { _all: true }, orderBy: { startDate: 'desc' } })
const weeks = [...new Set(g.map((r) => r.startDate.toISOString().slice(0, 10)))].sort().reverse()
const rowsOf = (w: string, m: string) => g.find((r) => r.startDate.toISOString().slice(0, 10) === w && r.marketplace === m)?._count._all ?? 0
const asinRows = await prisma.searchQueryPerformance.findMany({
  where: { reportPeriod: 'WEEK' }, select: { startDate: true, marketplace: true, asin: true }, distinct: ['startDate', 'marketplace', 'asin'] })
const asinsOf = (w: string, m: string) => asinRows.filter((r) => r.startDate.toISOString().slice(0, 10) === w && r.marketplace === m).length
for (const m of KT_MARKETS) {
  const byRows = weeks.map((w) => ({ start: new Date(w + 'T00:00:00Z'), rows: rowsOf(w, m) })).filter((p) => p.rows > 0)
  const byCov = weeks.map((w) => ({ start: new Date(w + 'T00:00:00Z'), rows: asinsOf(w, m) })).filter((p) => p.rows > 0)
  const a = chooseViewPeriod(byRows as any), b = chooseViewPeriod(byCov as any)
  const d = (x: any) => x.start ? new Date(x.start).toISOString().slice(0, 10) : 'none'
  const age = (x: any) => x.start ? `${((Date.now() - +new Date(x.start)) / 86_400_000).toFixed(0)}d` : '—'
  console.log(`  ${m}: newest week now ${rowsOf(weeks[0]!, m)} rows / ${asinsOf(weeks[0]!, m)} ASINs · threshold ${a.threshold}`)
  console.log(`      by rows → ${d(a)} (${age(a)}) "${a.reason}" · share measured across ${a.start ? asinsOf(d(a), m) : 0} ASINs`)
  console.log(`      by coverage → ${d(b)} (${age(b)}) "${b.reason}"`)
}
await prisma.$disconnect()
