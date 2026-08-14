/**
 * SQP.5 §4.2 — produce rate by REAL yield rank, not by request order.
 *
 * 🔴 My first attempt used request order as a proxy for rank and reported "the produce rate holds".
 * It does not measure that at all: the 08-02 requests span TWO batches with different aim — the
 * nightly pass at 03:45 (mis-aimed, pre-SQP.4 ordering) and an aimed batch at 15:31 — so "later
 * requests produce more" was measuring the aim fix, not the rank curve.
 *
 * This ranks the pool the way `planRequestSet` does and asks: as you go deeper down that ranking,
 * does the produce rate hold? That is the number that decides whether 38 requests buys 19 producing
 * ASINs or 14.
 */
import '../src/env.js'
import prisma from '../src/db.js'
import { ourAsinsForMarketplace } from '../src/services/advertising/sqp.service.js'
import { rankByYield, type AsinYieldEvidence } from '../src/services/advertising/sqp-yield.js'

for (const m of ['IT', 'DE', 'ES', 'FR']) {
  const pool = await ourAsinsForMarketplace(m, 250)
  const wins = await prisma.searchQueryPerformance.groupBy({
    by: ['asin'], where: { reportPeriod: 'WEEK', marketplace: m, asin: { in: pool } }, _count: { _all: true },
  })
  const weekRows = await prisma.searchQueryPerformance.findMany({
    where: { reportPeriod: 'WEEK', marketplace: m, asin: { in: pool } }, select: { asin: true, startDate: true }, distinct: ['asin', 'startDate'],
  })
  const weekCount = new Map<string, number>()
  for (const w of weekRows) if (w.asin) weekCount.set(w.asin, (weekCount.get(w.asin) ?? 0) + 1)
  const asked = await prisma.sqpReportRequest.groupBy({
    by: ['asin'], where: { marketplace: m, reportPeriod: 'WEEK', asin: { in: pool } }, _count: { _all: true },
  })
  const askedCount = new Map(asked.map((a) => [a.asin, a._count._all]))
  const evidence = new Map<string, AsinYieldEvidence>()
  for (const a of pool) evidence.set(a, {
    rows: wins.find((w) => w.asin === a)?._count._all ?? 0,
    weeksMeasured: weekCount.get(a) ?? 0,
    reportsRequested: askedCount.get(a) ?? 0,
  })
  const ranked = rankByYield(pool, evidence)
  const tiers = { proven: ranked.filter((r) => r.tier === 'proven').length, unproven: ranked.filter((r) => r.tier === 'unproven').length, barren: ranked.filter((r) => r.tier === 'barren').length }
  console.log(`━━━ ${m} · pool ${pool.length} · proven ${tiers.proven} · unproven ${tiers.unproven} · barren ${tiers.barren} ━━━`)
  // the produce rate we can actually observe is over PROVEN ASINs, by rank
  const proven = ranked.filter((r) => r.tier === 'proven')
  const band = (from: number, to: number) => {
    const s = proven.slice(from, to)
    if (!s.length) return `${from}-${to}: —`
    const rate = s.reduce((a, r) => a + r.rate, 0) / s.length
    return `${String(from + 1).padStart(2)}-${String(Math.min(to, proven.length)).padStart(2)}: mean ${rate.toFixed(1)} rows/measured-week`
  }
  console.log(`  proven ASINs by rank — ${[band(0,5), band(5,10), band(10,20), band(20,40)].join(' · ')}`)
  console.log(`  🔴 the pool holds only ${tiers.proven} PROVEN ASINs. A request set larger than that must`)
  console.log(`     spend the remainder on unproven/barren, whose produce rate is unmeasured here.`)
}

console.log('\n━━━ §10 · terms measured per market, on 2026-08-02 ━━━━━━━━━━━━━━━━━━━━━━━')
for (const m of ['IT', 'DE', 'ES', 'FR']) {
  const lists = await prisma.keywordWatchlist.findMany({ where: { marketplace: m }, select: { id: true } })
  const items = await prisma.keywordWatchlistTerm.findMany({ where: { watchlistId: { in: lists.map((l) => l.id) } }, select: { term: true } })
  const terms = new Set(items.map((i) => i.term.trim().toLowerCase()))
  const rows = await prisma.searchQueryPerformance.findMany({
    where: { marketplace: m, reportPeriod: 'WEEK', startDate: new Date('2026-08-02T00:00:00Z') }, select: { searchQuery: true }, distinct: ['searchQuery'],
  })
  const covered = rows.filter((r) => terms.has(r.searchQuery.trim().toLowerCase())).length
  console.log(`  ${m}: ${covered} of ${terms.size} watchlist terms measured  (${terms.size ? ((100*covered)/terms.size).toFixed(0) : '—'}%)`)
}
await prisma.$disconnect()
