/**
 * SQP.5 §6.2 — the only projection that matters: how many WATCHLIST TERMS does the Nth ASIN buy?
 *
 * Rows and ASINs are means; terms measured is the end (§10). This builds the marginal-term curve from
 * the richest week actually observed, so the projection rests on measurement rather than on a ratio.
 */
import '../src/env.js'
import prisma from '../src/db.js'

for (const m of ['IT', 'DE', 'ES']) {
  const lists = await prisma.keywordWatchlist.findMany({ where: { marketplace: m }, select: { id: true } })
  const items = await prisma.keywordWatchlistTerm.findMany({ where: { watchlistId: { in: lists.map((l) => l.id) } }, select: { term: true } })
  const watch = new Set(items.map((i) => i.term.trim().toLowerCase()))

  // the richest stored week for this market, by distinct ASINs
  const perWeek = await prisma.searchQueryPerformance.findMany({
    where: { marketplace: m, reportPeriod: 'WEEK' }, select: { startDate: true, asin: true }, distinct: ['startDate', 'asin'],
  })
  const cnt = new Map<string, number>()
  for (const r of perWeek) { const k = r.startDate.toISOString().slice(0, 10); cnt.set(k, (cnt.get(k) ?? 0) + 1) }
  const best = [...cnt.entries()].sort((a, b) => b[1] - a[1])[0]!
  console.log(`━━━ ${m} · watchlist ${watch.size} terms · richest week ${best[0]} with ${best[1]} ASINs ━━━`)

  for (const [label, wk] of [['richest', best[0]], ['current', '2026-08-02']] as const) {
    const rows = await prisma.searchQueryPerformance.findMany({
      where: { marketplace: m, reportPeriod: 'WEEK', startDate: new Date(wk + 'T00:00:00Z') },
      select: { asin: true, searchQuery: true },
    })
    if (!rows.length) { console.log(`  ${label} ${wk}: no rows`); continue }
    // rank ASINs by how many watchlist terms they carry, then accumulate distinct terms
    const byAsin = new Map<string, Set<string>>()
    for (const r of rows) {
      if (!r.asin) continue
      const t = r.searchQuery.trim().toLowerCase()
      if (!watch.has(t)) continue
      const s = byAsin.get(r.asin) ?? new Set(); s.add(t); byAsin.set(r.asin, s)
    }
    const ordered = [...byAsin.entries()].sort((a, b) => b[1].size - a[1].size)
    const acc = new Set<string>(); const curve: number[] = []
    for (const [, terms] of ordered) { for (const t of terms) acc.add(t); curve.push(acc.size) }
    const marks = [1, 2, 3, 5, 8, 10, 12, 15, 19, 25].filter((k) => k <= curve.length)
    console.log(`  ${label} ${wk}: ${ordered.length} ASINs carry watchlist terms → ${acc.size} of ${watch.size} terms`)
    console.log(`     cumulative terms at N ASINs: ${marks.map((k) => `${k}→${curve[k - 1]}`).join(' · ')}`)
    // marginal
    const marginal = curve.map((v, i) => (i === 0 ? v : v - curve[i - 1]!))
    console.log(`     marginal terms per added ASIN: ${marginal.slice(0, 20).join(',')}`)
  }
}
await prisma.$disconnect()
