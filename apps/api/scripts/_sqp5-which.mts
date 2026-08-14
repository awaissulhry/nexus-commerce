/**
 * SQP.5 — 🔴 if 10 ASINs bought 97 terms on 07-19 and 9 ASINs bought 40 on 08-02, the constraint is
 * WHICH ASINs, not how many. Which ones carry the watchlist, and does our yield ranking pick them?
 */
import '../src/env.js'
import prisma from '../src/db.js'
import { ourAsinsForMarketplace } from '../src/services/advertising/sqp.service.js'
import { rankByYield, type AsinYieldEvidence } from '../src/services/advertising/sqp-yield.js'

const m = 'IT'
const lists = await prisma.keywordWatchlist.findMany({ where: { marketplace: m }, select: { id: true } })
const items = await prisma.keywordWatchlistTerm.findMany({ where: { watchlistId: { in: lists.map((l) => l.id) } }, select: { term: true } })
const watch = new Set(items.map((i) => i.term.trim().toLowerCase()))

const termsByAsin = async (wk: string) => {
  const rows = await prisma.searchQueryPerformance.findMany({
    where: { marketplace: m, reportPeriod: 'WEEK', startDate: new Date(wk + 'T00:00:00Z') }, select: { asin: true, searchQuery: true },
  })
  const map = new Map<string, Set<string>>()
  for (const r of rows) {
    if (!r.asin) continue
    const t = r.searchQuery.trim().toLowerCase(); if (!watch.has(t)) continue
    const s = map.get(r.asin) ?? new Set(); s.add(t); map.set(r.asin, s)
  }
  return map
}
const rich = await termsByAsin('2026-07-19')
const now = await termsByAsin('2026-08-02')

console.log('━━━ ASINs that carry the IT watchlist, richest week 2026-07-19 ━━━━━━━━━━━')
const richOrdered = [...rich.entries()].sort((a, b) => b[1].size - a[1].size)
for (const [asin, t] of richOrdered) console.log(`  ${asin}  ${String(t.size).padStart(3)} watchlist terms${now.has(asin) ? `   · on 08-02 too (${now.get(asin)!.size})` : '   🔴 ABSENT on 08-02'}`)

const missing = new Set(watch)
for (const [, t] of now) for (const x of t) missing.delete(x)
const recoverable = new Set<string>()
for (const [asin, t] of rich) { if (!now.has(asin)) for (const x of t) if (missing.has(x)) recoverable.add(x) }
console.log(`\n  watchlist terms NOT measured on 08-02: ${missing.size} of ${watch.size}`)
console.log(`  of those, terms an ABSENT 07-19 ASIN carried: ${recoverable.size}  ⇒ recoverable by requesting those ASINs`)
console.log(`  the rest (${missing.size - recoverable.size}) were not measured in the richest week either.`)

console.log('\n━━━ 🔴 does our yield ranking (by ROWS) pick the term-carrying ASINs? ━━━━━━')
const pool = await ourAsinsForMarketplace(m, 250)
const wins = await prisma.searchQueryPerformance.groupBy({ by: ['asin'], where: { reportPeriod: 'WEEK', marketplace: m, asin: { in: pool } }, _count: { _all: true } })
const wkRows = await prisma.searchQueryPerformance.findMany({ where: { reportPeriod: 'WEEK', marketplace: m, asin: { in: pool } }, select: { asin: true, startDate: true }, distinct: ['asin', 'startDate'] })
const wc = new Map<string, number>(); for (const w of wkRows) if (w.asin) wc.set(w.asin, (wc.get(w.asin) ?? 0) + 1)
const asked = await prisma.sqpReportRequest.groupBy({ by: ['asin'], where: { marketplace: m, reportPeriod: 'WEEK', asin: { in: pool } }, _count: { _all: true } })
const ac = new Map(asked.map((a) => [a.asin, a._count._all]))
const ev = new Map<string, AsinYieldEvidence>()
for (const a of pool) ev.set(a, { rows: wins.find((w) => w.asin === a)?._count._all ?? 0, weeksMeasured: wc.get(a) ?? 0, reportsRequested: ac.get(a) ?? 0 })
const ranked = rankByYield(pool, ev).filter((r) => r.tier === 'proven')

// the ideal ordering: by watchlist terms carried, pooled over all weeks
const allRows = await prisma.searchQueryPerformance.findMany({ where: { marketplace: m, reportPeriod: 'WEEK' }, select: { asin: true, searchQuery: true }, distinct: ['asin', 'searchQuery'] })
const termCount = new Map<string, number>()
for (const r of allRows) { if (!r.asin) continue; const t = r.searchQuery.trim().toLowerCase(); if (!watch.has(t)) continue; termCount.set(r.asin, (termCount.get(r.asin) ?? 0) + 1) }
const byTerms = [...termCount.entries()].sort((a, b) => b[1] - a[1])

console.log('  rank  by ROWS (what we ship)          by WATCHLIST TERMS (what the page needs)')
for (let i = 0; i < 10; i++) {
  const a = ranked[i], b = byTerms[i]
  console.log(`   ${String(i + 1).padStart(2)}   ${(a ? `${a.asin} ${a.rate.toFixed(0)} rows/wk` : '—').padEnd(32)} ${b ? `${b[0]} ${b[1]} terms` : '—'}`)
}
const top10Rows = new Set(ranked.slice(0, 10).map((r) => r.asin))
const top10Terms = new Set(byTerms.slice(0, 10).map((b) => b[0]))
const overlap = [...top10Terms].filter((a) => top10Rows.has(a)).length
console.log(`\n  🔴 overlap of the two top-10s: ${overlap} of 10`)
const termsIfRows = new Set<string>(); for (const a of top10Rows) for (const [asin, t] of rich) if (asin === a) for (const x of t) termsIfRows.add(x)
const termsIfTerms = new Set<string>(); for (const a of top10Terms) for (const [asin, t] of rich) if (asin === a) for (const x of t) termsIfTerms.add(x)
console.log(`  on the richest week, the ROWS top-10 would have covered ${termsIfRows.size} terms; the TERMS top-10 ${termsIfTerms.size}.`)
await prisma.$disconnect()
