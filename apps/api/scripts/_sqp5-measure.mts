/**
 * SQP.5 — the three numbers §4 actually turns on, measured rather than inferred.
 *
 * 🔴 `rowsChanged = 0` has TWO causes and conflating them would invent a re-fetch finding: an EMPTY
 * report changes nothing because there was nothing, and a settled week changes nothing because it has
 * stopped moving. Only the second is evidence for a re-fetch policy.
 */
import '../src/env.js'
import prisma from '../src/db.js'

const reqs = await prisma.sqpReportRequest.findMany({
  select: { marketplace: true, asin: true, startDate: true, requestedAt: true, doneAt: true, collectedAt: true, rowsParsed: true, rowsChanged: true },
  orderBy: { requestedAt: 'asc' },
})

console.log('━━━ §4.4 · the two causes of rowsChanged = 0, separated ━━━━━━━━━━━━━━━━━━')
const known = reqs.filter((r) => r.rowsChanged !== null)
const emptyReport = known.filter((r) => (r.rowsParsed ?? 0) === 0)
const realNoChange = known.filter((r) => (r.rowsParsed ?? 0) > 0 && r.rowsChanged === 0)
const realChange = known.filter((r) => (r.rowsChanged ?? 0) > 0)
console.log(`  ${known.length} requests with rowsChanged known:`)
console.log(`    EMPTY report (rowsParsed = 0) — changed nothing because there was nothing: ${emptyReport.length}`)
console.log(`    had rows and changed NOTHING — a genuinely settled fetch:                  ${realNoChange.length}`)
console.log(`    had rows and changed something:                                            ${realChange.length}`)
console.log(`  🔴 only the middle row is evidence for a re-fetch policy.`)

const key = (r: typeof reqs[0]) => `${r.marketplace}|${r.asin}|${r.startDate.toISOString().slice(0, 10)}`
const byKey = new Map<string, typeof reqs>()
for (const r of reqs) { const l = byKey.get(key(r)) ?? []; l.push(r); byKey.set(key(r), l) }
const repeated = [...byKey.entries()].filter(([, l]) => l.length > 1)
console.log(`\n  (market, asin, week) asked more than once: ${repeated.length}`)
for (const [k, l] of repeated) {
  const spans = l.map((r, i) => i === 0 ? 'first' : `+${(((+r.requestedAt) - (+l[0]!.requestedAt)) / 3600_000).toFixed(1)}h`)
  console.log(`    ${k}: ${l.map((r, i) => `${spans[i]} parsed=${r.rowsParsed} changed=${r.rowsChanged ?? 'NULL'}`).join(' · ')}`)
}
console.log('  ⇒ n is small. State the limit rather than generalising from it.')

console.log('\n━━━ §4.2 · produce rate by RANK in the yield-ordered request set ━━━━━━━━━━')
for (const m of ['IT', 'DE', 'ES', 'FR']) {
  const week = new Date('2026-08-02T00:00:00Z')
  const rs = reqs.filter((r) => r.marketplace === m && +r.startDate === +week)
  if (!rs.length) { console.log(`  ${m}: no requests for 08-02`); continue }
  const produced = rs.filter((r) => (r.rowsParsed ?? 0) > 0)
  console.log(`  ${m}: ${rs.length} requests → ${produced.length} produced (${((100 * produced.length) / rs.length).toFixed(0)}%) → ${rs.reduce((s, r) => s + (r.rowsParsed ?? 0), 0)} rows`)
  // in request order, which IS yield order for the aimed batches
  const marks = rs.map((r) => ((r.rowsParsed ?? 0) > 0 ? '#' : '.')).join('')
  console.log(`      order: ${marks}   (# produced, . empty)`)
  const firstHalf = rs.slice(0, Math.ceil(rs.length / 2)), secondHalf = rs.slice(Math.ceil(rs.length / 2))
  const pr = (x: typeof rs) => x.length ? ((100 * x.filter((r) => (r.rowsParsed ?? 0) > 0).length) / x.length).toFixed(0) : '—'
  console.log(`      first half ${pr(firstHalf)}% · second half ${pr(secondHalf)}%  ⇒ ${Number(pr(secondHalf)) < Number(pr(firstHalf)) * 0.5 ? '🔴 COLLAPSES' : 'holds'}`)
}

console.log('\n━━━ §10 · the operator number: TERMS MEASURED per market ━━━━━━━━━━━━━━━━━')
for (const m of ['IT', 'DE', 'ES', 'FR']) {
  const lists = await prisma.keywordWatchlist.findMany({ where: { marketplace: m }, select: { id: true } })
  const items = await prisma.keywordWatchlistItem.findMany({
    where: { watchlistId: { in: lists.map((l) => l.id) } }, select: { term: true },
  })
  const terms = new Set(items.map((i) => i.term.trim().toLowerCase()))
  const week = new Date('2026-08-02T00:00:00Z')
  const rows = await prisma.searchQueryPerformance.findMany({
    where: { marketplace: m, reportPeriod: 'WEEK', startDate: week }, select: { searchQuery: true, asin: true }, distinct: ['searchQuery'],
  })
  const covered = rows.filter((r) => terms.has(r.searchQuery.trim().toLowerCase())).length
  const asins = await prisma.searchQueryPerformance.findMany({
    where: { marketplace: m, reportPeriod: 'WEEK', startDate: week }, select: { asin: true }, distinct: ['asin'],
  })
  console.log(`  ${m}: ${covered} of ${terms.size} watchlist terms measured on 2026-08-02 · ${asins.length} ASINs`)
}
await prisma.$disconnect()
