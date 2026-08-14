/**
 * KT.10 — re-measure §2 from scratch. The feed moves nightly and the prompt's table is from 08-14.
 *
 * 🔴 LIKE-FOR-LIKE: the market Δ is computed only over (searchQuery, asin) pairs present in BOTH
 * periods. An aggregate over all rows mixes coverage change into market change — the confound that
 * produced SQP.5's "one event, two effects" out of what may be a seasonal decline.
 */
import '../src/env.js'
import prisma from '../src/db.js'

console.log('━━━ §5 STOP CONDITIONS ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
const rt = await prisma.rankTarget.count({ where: { maxBiasPct: { not: null } } })
console.log(`  maxBiasPct non-null: ${rt}${rt ? '  🔴 STOP' : '  ✓'} · NEXUS_COVERAGE_ENGINE_MODE=[${process.env.NEXUS_COVERAGE_ENGINE_MODE ?? 'unset'}]`)
const weeks = await prisma.searchQueryPerformance.findMany({
  where: { reportPeriod: 'WEEK' }, select: { startDate: true }, distinct: ['startDate'], orderBy: { startDate: 'desc' }, take: 3,
})
console.log(`  newest stored weeks: ${weeks.map((w) => w.startDate.toISOString().slice(0, 10)).join(' · ')}${weeks[0]!.startDate.toISOString().slice(0,10) === '2026-08-02' ? '  ✓ still 08-02' : '  🔴 A NEW PERIOD LANDED'}`)

const A = new Date('2026-07-12T00:00:00Z'), B = new Date('2026-08-02T00:00:00Z')
console.log('\n━━━ §2.1 · like-for-like, on (query × ASIN) pairs present in BOTH weeks ━━━')
console.log('mkt   pairs   mktVolume A→B          mktImpr A→B         ourImpr A→B      our share A→B')
for (const m of ['IT', 'DE', 'ES', 'FR']) {
  const rows = await prisma.searchQueryPerformance.findMany({
    where: { marketplace: m, reportPeriod: 'WEEK', startDate: { in: [A, B] } },
    select: { startDate: true, searchQuery: true, asin: true, searchQueryVolume: true, impressionsTotal: true, impressionsBrand: true },
  })
  const key = (r: typeof rows[0]) => `${r.searchQuery}|${r.asin ?? ''}`
  const inA = new Map(rows.filter((r) => +r.startDate === +A).map((r) => [key(r), r]))
  const inB = new Map(rows.filter((r) => +r.startDate === +B).map((r) => [key(r), r]))
  const both = [...inA.keys()].filter((k) => inB.has(k))
  if (!both.length) { console.log(`${m}: no overlapping pairs`); continue }
  const sum = (mp: typeof inA, f: (r: any) => number) => both.reduce((s, k) => s + (f(mp.get(k)!) || 0), 0)
  const volA = sum(inA, (r) => r.searchQueryVolume), volB = sum(inB, (r) => r.searchQueryVolume)
  const impA = sum(inA, (r) => r.impressionsTotal), impB = sum(inB, (r) => r.impressionsTotal)
  const ourA = sum(inA, (r) => r.impressionsBrand), ourB = sum(inB, (r) => r.impressionsBrand)
  const pct = (x: number, y: number) => `${(((y - x) / (x || 1)) * 100).toFixed(0)}%`
  const sh = (o: number, t: number) => t ? `${((100 * o) / t).toFixed(3)}%` : '—'
  console.log(`${m.padEnd(4)} ${String(both.length).padStart(5)}   ${String(volA).padStart(6)}→${String(volB).padEnd(6)} ${pct(volA, volB).padStart(5)}   ${String(impA).padStart(6)}→${String(impB).padEnd(6)} ${pct(impA, impB).padStart(5)}   ${String(ourA).padStart(5)}→${String(ourB).padEnd(5)} ${pct(ourA, ourB).padStart(5)}   ${sh(ourA, impA)} → ${sh(ourB, impB)}`)
}

console.log('\n━━━ §2.2 · is there a hard 100-query-per-ASIN cap? ━━━━━━━━━━━━━━━━━━━━━━━')
const cells = await prisma.$queryRawUnsafe<Array<{ marketplace: string; startDate: Date; asin: string; n: number }>>(`
  SELECT "marketplace", "startDate", "asin", count(*)::int AS n
  FROM "SearchQueryPerformance" WHERE "reportPeriod" = 'WEEK' AND "asin" IS NOT NULL
  GROUP BY 1,2,3`)
const above = cells.filter((c) => c.n > 100), at = cells.filter((c) => c.n === 100)
console.log(`  ${cells.length} distinct (market, week, ASIN) cells · ABOVE 100: ${above.length} · at exactly 100: ${at.length}`)
console.log(above.length ? `  🔴 THE CAP IS NOT A CAP — §2.2 is wrong and §3.2 must not ship` : `  ✓ no cell has ever exceeded 100 — the cap holds`)
const byWeek = new Map<string, number>()
for (const c of at) { const k = c.startDate.toISOString().slice(0, 10); byWeek.set(k, (byWeek.get(k) ?? 0) + 1) }
console.log(`  at-cap cells by week: ${[...byWeek].sort().map(([k, v]) => `${k.slice(5)} ${v}`).join(' · ')}`)
await prisma.$disconnect()
