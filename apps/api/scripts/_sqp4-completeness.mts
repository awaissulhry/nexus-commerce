/**
 * SQP.4 §5.5 — cost the alternative definitions of "complete", with numbers.
 *
 * The current gate compares a week's ROW COUNT against the median row count of the 12 most recent
 * weeks. Two things break that:
 *   1. those 12 weeks were fed by DIFFERENT ASIN SETS, so it compares unlike with unlike;
 *   2. once the population is homogeneous the median collapses to the cron level and EVERY week
 *      passes — the gate stops protecting anything at all.
 *
 * Nothing here is applied. `keyword-tracker.service.ts` is a page file this session does not touch;
 * `chooseViewPeriod` is imported read-only and driven with injected options.
 */
import prisma from '../src/db.js'
import { chooseViewPeriod, KT_MARKETS, SQP_COMPLETENESS_RATIO, SQP_BASELINE_PERIODS, KT_LOOKBACK_DAYS } from '../src/services/advertising/keyword-tracker.service.js'

const g = await prisma.searchQueryPerformance.groupBy({
  by: ['startDate', 'marketplace'], where: { reportPeriod: 'WEEK' }, _count: { _all: true }, orderBy: { startDate: 'desc' },
})
const weeks = [...new Set(g.map((r) => r.startDate.toISOString().slice(0, 10)))].sort().reverse()
const rowsOf = (w: string, m: string) => g.find((r) => r.startDate.toISOString().slice(0, 10) === w && r.marketplace === m)?._count._all ?? 0
const asinRows = await prisma.searchQueryPerformance.findMany({
  where: { reportPeriod: 'WEEK' }, select: { startDate: true, marketplace: true, asin: true }, distinct: ['startDate', 'marketplace', 'asin'],
})
const asinsOf = (w: string, m: string) => asinRows.filter((r) => r.startDate.toISOString().slice(0, 10) === w && r.marketplace === m).length
const median = (xs: number[]) => { const s = [...xs].sort((a, b) => a - b); const m = s.length >> 1; return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2 }

console.log('━━━ A · the metric today: ROWS per week ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
console.log('mkt  series(newest→oldest)                             median  thr   newest  passes')
for (const m of KT_MARKETS) {
  const s = weeks.map((w) => rowsOf(w, m))
  const base = median(s.slice(0, SQP_BASELINE_PERIODS)), thr = SQP_COMPLETENESS_RATIO * base
  console.log(`${m.padEnd(4)} ${JSON.stringify(s).padEnd(50)} ${String(base).padStart(6)} ${String(thr).padStart(5)} ${String(s[0]).padStart(7)}  ${s[0]! >= thr ? 'yes' : 'NO'}`)
}

console.log('\n━━━ B · 🔴 the metric goes VACUOUS once the population is homogeneous ━━━━━')
console.log('Simulating 8 more weeks at the CURRENT (mis-aimed) yield — the same number the gate would')
console.log('then be judging against becomes the number being judged:')
for (const m of KT_MARKETS) {
  const cron = rowsOf(weeks[0]!, m)
  let sim = weeks.map((w) => rowsOf(w, m))
  for (let k = 0; k < 8; k++) sim = [cron, ...sim]
  const base = median(sim.slice(0, SQP_BASELINE_PERIODS)), thr = SQP_COMPLETENESS_RATIO * base
  console.log(`  ${m}: baseline → ${base}, threshold → ${thr}, week has ${cron} ⇒ ${cron >= thr ? 'PASSES — on a threshold its own thinness set' : 'fails'}`)
}

console.log('\n━━━ C · the alternative: ASIN COVERAGE per week (scale-free) ━━━━━━━━━━━━━━')
console.log('mkt  coverage(newest→oldest)                     median  thr   newest  passes')
for (const m of KT_MARKETS) {
  const s = weeks.map((w) => asinsOf(w, m))
  const base = median(s.slice(0, SQP_BASELINE_PERIODS)), thr = SQP_COMPLETENESS_RATIO * base
  console.log(`${m.padEnd(4)} ${JSON.stringify(s).padEnd(44)} ${String(base).padStart(6)} ${String(thr).padStart(5)} ${String(s[0]).padStart(7)}  ${s[0]! >= thr ? 'yes' : 'NO'}`)
}

console.log('\n━━━ D · which PERIOD each definition picks, per market ━━━━━━━━━━━━━━━━━━━━')
for (const m of KT_MARKETS) {
  const byRows = weeks.map((w) => ({ start: new Date(w + 'T00:00:00Z'), rows: rowsOf(w, m) })).filter((p) => p.rows > 0)
  const byAsins = weeks.map((w) => ({ start: new Date(w + 'T00:00:00Z'), rows: asinsOf(w, m) })).filter((p) => p.rows > 0)
  const a = chooseViewPeriod(byRows as any)
  const b = chooseViewPeriod(byAsins as any)
  const d = (x: any) => x.start ? new Date(x.start).toISOString().slice(0, 10) : 'none'
  const ageOf = (x: any) => x.start ? ((Date.now() - +new Date(x.start)) / 86_400_000).toFixed(0) + 'd' : '—'
  console.log(`  ${m}: rows→ ${d(a)} (${ageOf(a)}, ${a.rows} rows, ${a.reason})   coverage→ ${d(b)} (${ageOf(b)}, ${b.rows} ASINs, ${b.reason})`)
}

console.log('\n━━━ E · an ABSOLUTE floor, for comparison ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
for (const floor of [5, 8, 10]) {
  const picks = KT_MARKETS.map((m) => {
    const w = weeks.find((w) => asinsOf(w, m) >= floor && (Date.now() - Date.parse(w + 'T00:00:00Z')) / 86_400_000 <= KT_LOOKBACK_DAYS)
    return `${m}:${w ?? 'none'}`
  })
  console.log(`  floor ≥${floor} ASINs: ${picks.join('  ')}`)
}
await prisma.$disconnect()
