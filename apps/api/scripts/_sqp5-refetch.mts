/**
 * SQP.5 §4.4 — the measurement the ledger cannot supply: does a 13-day-old week still MOVE?
 *
 * Every existing fetch of 2026-08-02 landed at week-age 11.9-12.6d, so nothing in the ledger separates
 * "the week is young and filling" from "the week is thin at Amazon". Re-fetching the six core IT ASINs
 * now, ~1.5 days later, produces the first observation at a different age — and `rowsChanged` answers
 * it directly, which is why SQP.3 added that column.
 *
 * 6 reports. Well inside one nightly pass; raises no budget.
 */
import '../src/env.js'
import prisma from '../src/db.js'
import { requestSqpReports, collectSqpReports } from '../src/services/advertising/sqp-async.service.js'

const CORE = ['B0BMSH19GY', 'B0BMSWM15B', 'B0BMSJWW7L', 'B0BMS6ZZ4H', 'B0D8S567P5', 'B0DJ4926YX']
const WEEK = new Date('2026-08-02T00:00:00Z')
const END = new Date('2026-08-08T00:00:00Z')
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

const before = await prisma.searchQueryPerformance.groupBy({
  by: ['asin'], where: { marketplace: 'IT', reportPeriod: 'WEEK', startDate: WEEK, asin: { in: CORE } }, _count: { _all: true },
})
console.log('BEFORE:', before.map((b) => `${b.asin}=${b._count._all}`).join(' '), '· total', before.reduce((s, b) => s + b._count._all, 0))

const mk = await prisma.marketplace.findFirst({ where: { code: 'IT', channel: 'AMAZON' }, select: { marketplaceId: true } })
const r = await requestSqpReports({ marketplaceCode: 'IT', marketplaceId: mk!.marketplaceId!, asins: CORE, period: 'WEEK', start: WEEK, end: END })
console.log(`requested: created=${r.created} settled=${r.alreadySettled} outstanding=${r.alreadyOutstanding} failed=${r.failed}`)
if (!r.created) { console.log('nothing created — the settle rule skipped them; that is the answer for those ASINs'); }

for (let i = 0; i < 60; i++) {
  await sleep(20_000)
  const c = await collectSqpReports({ limit: 30 })
  if (c.ingested) console.log(`  ingested=${c.ingested} rows=${c.rowsUpserted} 🔴 CHANGED=${c.rowsChanged} pending=${c.stillPending}`)
  if (!c.stillPending && i > 2) break
}

const after = await prisma.sqpReportRequest.findMany({
  where: { marketplace: 'IT', reportPeriod: 'WEEK', startDate: WEEK, asin: { in: CORE } },
  select: { asin: true, requestedAt: true, rowsParsed: true, rowsChanged: true }, orderBy: { requestedAt: 'asc' },
})
console.log('\n━━━ every fetch of 08-02 for the core ASINs, by week-age ━━━━━━━━━━━━━━━━━')
for (const x of after) {
  const age = (+x.requestedAt - +WEEK) / 86_400_000
  console.log(`  ${x.asin}  age ${age.toFixed(1)}d  parsed=${x.rowsParsed} changed=${x.rowsChanged ?? 'NULL'}`)
}
const latest = after.filter((x) => (+x.requestedAt - +WEEK) / 86_400_000 > 13)
const moved = latest.reduce((s, x) => s + (x.rowsChanged ?? 0), 0)
console.log(`\n🔴 VERDICT: ${latest.length} fetches at week-age >13d · rows CHANGED = ${moved}`)
console.log(moved > 0
  ? '  ⇒ the week is STILL MOVING at 13 days. Thinness is partly age, and re-fetching young weeks buys terms.'
  : '  ⇒ the week did NOT move. 2026-08-02 is genuinely thin at Amazon; more ASINs will not recover those terms.')
await prisma.$disconnect()
