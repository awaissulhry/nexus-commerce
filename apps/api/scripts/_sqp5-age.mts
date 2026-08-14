/**
 * SQP.5 — 🔴 the hypothesis the numbers actually point at: is the 08-02 week thin because it is YOUNG?
 *
 * SQP.3 measured weeks frozen at 25 and 46 days and explicitly recorded that day 5 → day 25 was
 * UNMEASURED. 08-02 is 12 days old. If a week fills in over its first weeks, the fix for "40 of 97"
 * is to re-fetch a young week, not to buy more ASINs — the opposite of what §3 proposes.
 */
import '../src/env.js'
import prisma from '../src/db.js'

const m = 'IT'
const lists = await prisma.keywordWatchlist.findMany({ where: { marketplace: m }, select: { id: true } })
const items = await prisma.keywordWatchlistTerm.findMany({ where: { watchlistId: { in: lists.map((l) => l.id) } }, select: { term: true } })
const watch = new Set(items.map((i) => i.term.trim().toLowerCase()))

// For each week: age, and the terms/rows the SAME core ASINs carried.
const CORE = ['B0BMSH19GY', 'B0BMSWM15B', 'B0BMSJWW7L', 'B0BMS6ZZ4H', 'B0D8S567P5', 'B0DJ4926YX']
const rows = await prisma.searchQueryPerformance.findMany({
  where: { marketplace: m, reportPeriod: 'WEEK', asin: { in: CORE } },
  select: { startDate: true, asin: true, searchQuery: true, ingestedAt: true },
})
const weeks = [...new Set(rows.map((r) => r.startDate.toISOString().slice(0, 10)))].sort().reverse()
console.log('week        ageNow  ASINsPresent  rows  watchlistTerms   firstIngest  ageAtIngest')
for (const w of weeks) {
  const rs = rows.filter((r) => r.startDate.toISOString().slice(0, 10) === w)
  const asins = new Set(rs.map((r) => r.asin))
  const terms = new Set(rs.map((r) => r.searchQuery.trim().toLowerCase()).filter((t) => watch.has(t)))
  const ing = rs.map((r) => +r.ingestedAt).sort((a, b) => a - b)[0]!
  const ageNow = (Date.now() - Date.parse(w + 'T00:00:00Z')) / 86_400_000
  const ageAtIngest = (ing - Date.parse(w + 'T00:00:00Z')) / 86_400_000
  console.log(`${w}  ${ageNow.toFixed(0).padStart(6)}  ${String(asins.size).padStart(12)}  ${String(rs.length).padStart(4)}  ${String(terms.size).padStart(14)}   ${new Date(ing).toISOString().slice(5, 10)}       ${ageAtIngest.toFixed(0)}d`)
}
console.log('\n🔴 ageAtIngest is when WE fetched it, and it is confounded with the week itself.')
console.log('   A week fetched at 8 days old and one fetched at 14 differ in BOTH age and calendar week.')

console.log('\n━━━ the clean test: 08-02 fetched TWICE, at different ages ━━━━━━━━━━━━━━━')
const reqs = await prisma.sqpReportRequest.findMany({
  where: { marketplace: m, reportPeriod: 'WEEK', startDate: new Date('2026-08-02T00:00:00Z'), asin: { in: CORE } },
  select: { asin: true, requestedAt: true, rowsParsed: true, rowsChanged: true }, orderBy: { requestedAt: 'asc' },
})
for (const r of reqs) {
  const age = (+r.requestedAt - Date.parse('2026-08-02T00:00:00Z')) / 86_400_000
  console.log(`  ${r.asin}  requested at week-age ${age.toFixed(1)}d  parsed=${r.rowsParsed} changed=${r.rowsChanged ?? 'NULL'}`)
}
console.log('\n  ⇒ if every fetch of 08-02 happened at a similar age, this data CANNOT separate')
console.log('    "the week is young" from "the week is thin". Say so rather than picking one.')
await prisma.$disconnect()
