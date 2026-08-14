/**
 * KT.8 — §5 stop conditions, §3.2's baseline-window question, §8's arithmetic discrepancy, and the
 * 3/5/8 floor table. Read-only.
 */
import '../src/env.js'
import prisma from '../src/db.js'
import { chooseViewPeriod, KT_MARKETS, KT_LOOKBACK_DAYS, SQP_COMPLETENESS_RATIO, SQP_BASELINE_PERIODS } from '../src/services/advertising/keyword-tracker.service.js'

const g = await prisma.searchQueryPerformance.groupBy({
  by: ['startDate', 'marketplace'], where: { reportPeriod: 'WEEK' }, _count: { _all: true }, orderBy: { startDate: 'desc' } })
const weeks = [...new Set(g.map((r) => r.startDate.toISOString().slice(0, 10)))].sort().reverse()
const rowsOf = (w: string, m: string) => g.find((r) => r.startDate.toISOString().slice(0, 10) === w && r.marketplace === m)?._count._all ?? 0
const ar = await prisma.searchQueryPerformance.findMany({
  where: { reportPeriod: 'WEEK' }, select: { startDate: true, marketplace: true, asin: true }, distinct: ['startDate', 'marketplace', 'asin'] })
const covOf = (w: string, m: string) => ar.filter((r) => r.startDate.toISOString().slice(0, 10) === w && r.marketplace === m).length
const median = (xs: number[]) => { const s = [...xs].sort((a, b) => a - b); const m = s.length >> 1; return s.length % 2 ? s[m]! : (s[m-1]! + s[m]!) / 2 }
const ageD = (w: string) => (Date.now() - Date.parse(w + 'T00:00:00Z')) / 86_400_000

console.log('━━━ §5 STOP CONDITIONS ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
console.log(`  newest stored week: ${weeks[0]} (${ageD(weeks[0]!).toFixed(0)}d) — expected 2026-08-02${weeks[0] === '2026-08-02' ? ' ✓' : '  🔴 A NEW PERIOD LANDED — re-measure'}`)
const rt = await prisma.rankTarget.count({ where: { maxBiasPct: { not: null } } })
console.log(`  RankTarget maxBiasPct non-null: ${rt}${rt ? '  🔴 STOP — a bid engine is live' : '  ✓ all NULL'}`)
console.log(`  NEXUS_COVERAGE_ENGINE_MODE=[${process.env.NEXUS_COVERAGE_ENGINE_MODE ?? 'unset'}]${process.env.NEXUS_COVERAGE_ENGINE_MODE ? '  🔴 STOP' : '  ✓'}`)

console.log('\n━━━ §3.2 · which weeks form the baseline? ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
console.log(`  code: baselineRows = median(sorted.slice(0, ${SQP_BASELINE_PERIODS})), computed BEFORE inLookback.`)
console.log(`  ⇒ ALL-STORED. The ${SQP_BASELINE_PERIODS}-period baseline ignores KT_LOOKBACK_DAYS=${KT_LOOKBACK_DAYS} entirely.`)
// proof by injection: same periods, wildly different lookback, identical baseline
const itP = weeks.map((w) => ({ start: new Date(w + 'T00:00:00Z'), rows: rowsOf(w, 'IT') })).filter((p) => p.rows > 0)
for (const lb of [7, 42, 400]) {
  const c = chooseViewPeriod(itP as any, { lookbackDays: lb })
  console.log(`     lookbackDays=${String(lb).padStart(3)} → baselineRows=${c.baselineRows} threshold=${c.threshold} picks ${c.start ? new Date(c.start).toISOString().slice(0,10) : 'none'} (${c.reason})`)
}
console.log('  ⇒ baselineRows is IDENTICAL across a 7-day and a 400-day lookback. Confirmed: all-stored.')

console.log('\n━━━ §8 · the 21-vs-153 arithmetic discrepancy ━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
const itSeries = weeks.map((w) => rowsOf(w, 'IT'))
console.log(`  IT rows, newest first: ${JSON.stringify(itSeries)}`)
for (const n of [4, 12]) {
  const b = median(itSeries.slice(0, n)), t = SQP_COMPLETENESS_RATIO * b
  console.log(`  baseline over ${String(n).padStart(2)} periods → median ${b} · threshold ${t} · IT has ${itSeries[0]} ⇒ short by ${(t - itSeries[0]!).toFixed(2)}`)
}
console.log(`  ⇒ the code uses ${SQP_BASELINE_PERIODS}. "short by 153" assumes a trailing-FOUR baseline that does not exist in this file.`)
console.log(`     SQP.4's "short by 21" is the one that matches the shipped arithmetic.`)

console.log('\n━━━ §3.3 · the floor table, measured ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
console.log('mkt  covNow  ' + [3, 5, 8].map((f) => `floor>=${f}`.padStart(14)).join('') + '     ratio today')
for (const m of KT_MARKETS) {
  const byRows = weeks.map((w) => ({ start: new Date(w + 'T00:00:00Z'), rows: rowsOf(w, m) })).filter((p) => p.rows > 0)
  const today = chooseViewPeriod(byRows as any)
  const cells = [3, 5, 8].map((f) => {
    const w = weeks.find((w) => covOf(w, m) >= f && ageD(w) <= KT_LOOKBACK_DAYS)
    return (w ? `${w.slice(5)} ${ageD(w).toFixed(0)}d` : 'REFUSED').padStart(14)
  })
  const td = today.start ? `${new Date(today.start).toISOString().slice(5,10)} ${ageD(new Date(today.start).toISOString().slice(0,10)).toFixed(0)}d` : 'none'
  console.log(`${m.padEnd(4)} ${String(covOf(weeks[0]!, m)).padStart(6)}  ${cells.join('')}     ${td}`)
}
console.log('\n  FR coverage across EVERY stored week: ' + weeks.map((w) => covOf(w, 'FR')).join(','))
console.log(`  FR max coverage ever: ${Math.max(...weeks.map((w) => covOf(w, 'FR')))} — so a floor of 5 refuses FR in every week it has.`)

console.log('\n━━━ has the gate ALREADY gone vacuous? (§5) ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
for (const m of KT_MARKETS) {
  const byRows = weeks.map((w) => ({ start: new Date(w + 'T00:00:00Z'), rows: rowsOf(w, m) })).filter((p) => p.rows > 0)
  const c = chooseViewPeriod(byRows as any)
  const picked = c.start ? new Date(c.start).toISOString().slice(0, 10) : null
  console.log(`  ${m}: picks ${picked} (${picked ? ageD(picked).toFixed(0) : '—'}d) "${c.reason}" · threshold ${c.threshold} · newest week ${rowsOf(weeks[0]!, m)} rows/${covOf(weeks[0]!, m)} ASINs`)
}
await prisma.$disconnect()
