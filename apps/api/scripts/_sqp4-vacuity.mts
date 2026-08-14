/**
 * SQP.4 — 🔴 checking my own claim. I wrote that ASIN coverage "does not go vacuous because it is
 * bounded by the ASIN pool". That is wrong: coverage is bounded by how many ASINs we REQUEST, so a
 * coverage-vs-own-median gate collapses exactly like the rows one. Measuring it rather than asserting.
 */
import prisma from '../src/db.js'
import { chooseViewPeriod, KT_MARKETS, SQP_COMPLETENESS_RATIO, SQP_BASELINE_PERIODS, KT_LOOKBACK_DAYS } from '../src/services/advertising/keyword-tracker.service.js'
const g = await prisma.searchQueryPerformance.groupBy({
  by: ['startDate', 'marketplace'], where: { reportPeriod: 'WEEK' }, _count: { _all: true }, orderBy: { startDate: 'desc' } })
const weeks = [...new Set(g.map((r) => r.startDate.toISOString().slice(0, 10)))].sort().reverse()
const rowsOf = (w: string, m: string) => g.find((r) => r.startDate.toISOString().slice(0, 10) === w && r.marketplace === m)?._count._all ?? 0
const ar = await prisma.searchQueryPerformance.findMany({
  where: { reportPeriod: 'WEEK' }, select: { startDate: true, marketplace: true, asin: true }, distinct: ['startDate', 'marketplace', 'asin'] })
const covOf = (w: string, m: string) => ar.filter((r) => r.startDate.toISOString().slice(0, 10) === w && r.marketplace === m).length
const median = (xs: number[]) => { const s = [...xs].sort((a, b) => a - b); const m = s.length >> 1; return s.length % 2 ? s[m]! : (s[m-1]! + s[m]!) / 2 }

console.log('━━━ does COVERAGE-vs-own-median also go vacuous? simulate 8 weeks at today\'s coverage ━━━')
for (const m of KT_MARKETS) {
  const cov = covOf(weeks[0]!, m)
  let sim = weeks.map((w) => covOf(w, m))
  for (let k = 0; k < 8; k++) sim = [cov, ...sim]
  const base = median(sim.slice(0, SQP_BASELINE_PERIODS)), thr = SQP_COMPLETENESS_RATIO * base
  console.log(`  ${m}: coverage ${cov} · baseline → ${base} · threshold → ${thr} ⇒ ${cov >= thr ? '🔴 PASSES — same vacuity, different quantity' : 'fails'}`)
}

console.log('\n━━━ an ABSOLUTE coverage floor, on today\'s data ━━━━━━━━━━━━━━━━━━━━━━━━━━')
console.log('mkt  coverage now  ' + [3,5,8,10].map((f) => `floor≥${f}`.padStart(9)).join(''))
for (const m of KT_MARKETS) {
  const now = covOf(weeks[0]!, m)
  const picks = [3,5,8,10].map((f) => {
    const w = weeks.find((w) => covOf(w, m) >= f && (Date.now() - Date.parse(w + 'T00:00:00Z')) / 86_400_000 <= KT_LOOKBACK_DAYS)
    return (w ? w.slice(5) : 'none').padStart(9)
  })
  console.log(`${m.padEnd(4)} ${String(now).padStart(12)}  ${picks.join('')}`)
}
console.log('\n  🔴 a floor cannot go vacuous — it is not computed from our own output. It also tells the')
console.log('  truth about FR by refusing, where a self-median would eventually accept 1 ASIN.')

console.log('\n━━━ and what each gate picks RIGHT NOW ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
for (const m of KT_MARKETS) {
  const byRows = weeks.map((w) => ({ start: new Date(w + 'T00:00:00Z'), rows: rowsOf(w, m) })).filter((p) => p.rows > 0)
  const byCov = weeks.map((w) => ({ start: new Date(w + 'T00:00:00Z'), rows: covOf(w, m) })).filter((p) => p.rows > 0)
  const a = chooseViewPeriod(byRows as any), b = chooseViewPeriod(byCov as any)
  const d = (x: any) => x.start ? new Date(x.start).toISOString().slice(0,10) : 'none'
  const age = (x: any) => x.start ? `${((Date.now() - +new Date(x.start))/86_400_000).toFixed(0)}d` : '—'
  const floor5 = weeks.find((w) => covOf(w, m) >= 5 && (Date.now() - Date.parse(w + 'T00:00:00Z'))/86_400_000 <= KT_LOOKBACK_DAYS)
  console.log(`  ${m}: rows→${d(a)} (${age(a)})  ·  cov-median→${d(b)} (${age(b)})  ·  cov-floor≥5→${floor5 ?? 'none'}`)
}
await prisma.$disconnect()
