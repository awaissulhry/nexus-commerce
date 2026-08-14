/**
 * KT.10 §2.3 — young or genuinely thin, settled by a week that cannot be young.
 *
 * SQP.5's re-fetch test answered "did not move", but only n=2 clear SQP.3's 20h admissibility bar.
 * Stronger test: 2026-07-19 is 27 days old and SQP.3 measured weeks frozen by 25. If the decline is
 * ALREADY visible between 07-12 and 07-19 — both settled — then 08-02's youth cannot be the cause.
 */
import '../src/env.js'
import prisma from '../src/db.js'

const W = (s: string) => new Date(s + 'T00:00:00Z')
const pairs = async (m: string, a: Date, b: Date) => {
  const rows = await prisma.searchQueryPerformance.findMany({
    where: { marketplace: m, reportPeriod: 'WEEK', startDate: { in: [a, b] } },
    select: { startDate: true, searchQuery: true, asin: true, searchQueryVolume: true, impressionsTotal: true, impressionsBrand: true },
  })
  const k = (r: typeof rows[0]) => `${r.searchQuery}|${r.asin ?? ''}`
  const A = new Map(rows.filter((r) => +r.startDate === +a).map((r) => [k(r), r]))
  const B = new Map(rows.filter((r) => +r.startDate === +b).map((r) => [k(r), r]))
  const both = [...A.keys()].filter((x) => B.has(x))
  const s = (mp: typeof A, f: (r: any) => number) => both.reduce((t, x) => t + (f(mp.get(x)!) || 0), 0)
  return { n: both.length, volA: s(A, (r) => r.searchQueryVolume), volB: s(B, (r) => r.searchQueryVolume),
           impA: s(A, (r) => r.impressionsTotal), impB: s(B, (r) => r.impressionsTotal),
           ourA: s(A, (r) => r.impressionsBrand), ourB: s(B, (r) => r.impressionsBrand) }
}
const pc = (x: number, y: number) => `${(((y - x) / (x || 1)) * 100).toFixed(0)}%`
const sh = (o: number, t: number) => t ? `${((100 * o) / t).toFixed(3)}%` : '—'

console.log('━━━ the decline across SETTLED weeks only (both ≥27 days old) ━━━━━━━━━━━━')
console.log('mkt  window            pairs   mktVolume       ourImpr     our share')
for (const m of ['IT', 'DE']) {
  for (const [la, a, b] of [['07-12 → 07-19 (settled→settled)', '2026-07-12', '2026-07-19'],
                            ['07-19 → 08-02 (settled→young?)', '2026-07-19', '2026-08-02'],
                            ['07-12 → 08-02 (the headline)  ', '2026-07-12', '2026-08-02']] as const) {
    const r = await pairs(m, W(a), W(b))
    console.log(`${m.padEnd(4)} ${la}  ${String(r.n).padStart(4)}   ${pc(r.volA, r.volB).padStart(5)}   ${pc(r.ourA, r.ourB).padStart(6)}   ${sh(r.ourA, r.impA)} → ${sh(r.ourB, r.impB)}`)
  }
}
console.log('\n🔴 If 07-12 → 07-19 already shows the decline, both weeks are settled (27d and 34d,')
console.log('   against SQP.3\'s measured freeze by 25d) and 08-02\'s age cannot be the cause.')

console.log('\n━━━ at-cap cells per week, with each week\'s age ━━━━━━━━━━━━━━━━━━━━━━━━━━')
const cells = await prisma.$queryRawUnsafe<Array<{ startDate: Date; n: number; cells: number }>>(`
  SELECT "startDate", count(*) FILTER (WHERE c = 100)::int AS n, count(*)::int AS cells FROM (
    SELECT "startDate", "marketplace", "asin", count(*)::int AS c
    FROM "SearchQueryPerformance" WHERE "reportPeriod"='WEEK' AND "asin" IS NOT NULL
    GROUP BY 1,2,3) t GROUP BY 1 ORDER BY 1 DESC`)
for (const c of cells) {
  const wk = c.startDate.toISOString().slice(0, 10)
  const age = ((Date.now() - +c.startDate) / 86_400_000).toFixed(0)
  console.log(`  ${wk} (${age.padStart(2)}d)  ${String(c.n).padStart(2)} of ${String(c.cells).padStart(2)} cells at the 100 cap${Number(age) >= 25 ? '   ← settled' : '   ← may still be filling'}`)
}
await prisma.$disconnect()
