/**
 * SQP.4 — 🔴 the question the model raised: is the nightly pass asking for the WRONG ASINs?
 *
 * Historical weeks hold 13-19 measured ASINs per market; the newest holds 1-6, from the same 10
 * requests. If the ASINs that historically returned rows are not the ones the pass now requests, the
 * gap is a SELECTION defect, not a budget one — and fixing it costs zero extra reports.
 */
import prisma from '../src/db.js'
import { ourAsinsForMarketplace } from '../src/services/advertising/sqp.service.js'

const KT = ['IT', 'DE', 'ES', 'FR']
const HIST = ['2026-07-12', '2026-07-05', '2026-06-28', '2026-06-21', '2026-06-14']

for (const m of KT) {
  // ASINs that produced rows in the high-yield historical weeks, ranked by total rows
  const hist = await prisma.searchQueryPerformance.groupBy({
    by: ['asin'],
    where: { reportPeriod: 'WEEK', marketplace: m, startDate: { in: HIST.map((d) => new Date(d + 'T00:00:00Z')) } },
    _count: { _all: true },
  })
  const ranked = hist.filter((h) => h.asin).map((h) => ({ asin: h.asin!, rows: h._count._all })).sort((a, b) => b.rows - a.rows)
  const proven = new Set(ranked.map((r) => r.asin))

  const nightly = await ourAsinsForMarketplace(m, 10)
  const overlap = nightly.filter((a) => proven.has(a))
  const provenRowsOfNightly = ranked.filter((r) => nightly.includes(r.asin)).reduce((s, r) => s + r.rows, 0)
  const top10Proven = ranked.slice(0, 10)

  console.log(`━━━ ${m} ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`)
  console.log(`  ASINs that returned rows in the 5 historical weeks: ${ranked.length}  (total ${ranked.reduce((s, r) => s + r.rows, 0)} rows)`)
  console.log(`  the nightly pass requests: ${nightly.join(' ')}`)
  console.log(`  🔴 of those 10, PROVEN to return rows: ${overlap.length}  (${provenRowsOfNightly} historical rows between them)`)
  console.log(`  the 10 best-proven ASINs:  ${top10Proven.map((r) => `${r.asin}:${r.rows}`).join(' ')}`)
  console.log(`     ⇒ requesting those instead would target ${top10Proven.reduce((s, r) => s + r.rows, 0)} historical rows vs ${provenRowsOfNightly}`)
}

console.log('\n━━━ where do the proven ASINs sit in the selection order? ━━━━━━━━━━━━━━━━')
for (const m of KT) {
  const hist = await prisma.searchQueryPerformance.groupBy({
    by: ['asin'], where: { reportPeriod: 'WEEK', marketplace: m, startDate: { in: HIST.map((d) => new Date(d + 'T00:00:00Z')) } }, _count: { _all: true },
  })
  const ranked = hist.filter((h) => h.asin).map((h) => ({ asin: h.asin!, rows: h._count._all })).sort((a, b) => b.rows - a.rows)
  const pool = await ourAsinsForMarketplace(m, 250)
  const pos = ranked.slice(0, 10).map((r) => { const i = pool.indexOf(r.asin); return i < 0 ? 'absent' : String(i) })
  console.log(`  ${m}: best-proven ASINs sit at selection ranks [${pos.join(', ')}] of ${pool.length}`)
}
await prisma.$disconnect()
