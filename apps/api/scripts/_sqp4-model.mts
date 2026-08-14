/**
 * SQP.4 §4 — the model. Can a cron-fed week pass the gate, at what report cost, and how does that
 * change as the backfill weeks leave the 12-period baseline? Read-only; no Amazon calls.
 *
 * 🔴 The brief says "trailing-4 median". It is `SQP_BASELINE_PERIODS = 12`, and the baseline is NOT
 * limited by the lookback — so backfill weeks keep inflating the threshold long after they stop being
 * selectable. That distinction is the whole model.
 */
import prisma from '../src/db.js'
import { chooseViewPeriod, KT_MARKETS, SQP_COMPLETENESS_RATIO, SQP_BASELINE_PERIODS, KT_LOOKBACK_DAYS } from '../src/services/advertising/keyword-tracker.service.js'

const g = await prisma.searchQueryPerformance.groupBy({
  by: ['startDate', 'marketplace'], where: { reportPeriod: 'WEEK' }, _count: { _all: true }, orderBy: { startDate: 'desc' },
})
const weeks = [...new Set(g.map((r) => r.startDate.toISOString().slice(0, 10)))].sort().reverse()
const rowsOf = (w: string, m: string) => g.find((r) => r.startDate.toISOString().slice(0, 10) === w && r.marketplace === m)?._count._all ?? 0

// distinct ASINs per (week, market) — the honest cron-vs-backfill classifier, and §6.6's reach line
const asinRows = await prisma.searchQueryPerformance.findMany({
  where: { reportPeriod: 'WEEK' }, select: { startDate: true, marketplace: true, asin: true }, distinct: ['startDate', 'marketplace', 'asin'],
})
const asinsOf = (w: string, m: string) => asinRows.filter((r) => r.startDate.toISOString().slice(0, 10) === w && r.marketplace === m).length

console.log('━━━ distinct ASINs per week — cron weeks cover 10/market by construction ━━━')
console.log('week        ' + KT_MARKETS.map((m) => m.padStart(9)).join('') + '    kind')
for (const w of weeks) {
  const a = KT_MARKETS.map((m) => asinsOf(w, m))
  const kind = a.reduce((s, x) => s + x, 0) <= 4 * 12 ? 'CRON' : 'backfill'
  console.log(`${w}  ${a.map((x) => String(x).padStart(9)).join('')}    ${kind}`)
}

const median = (xs: number[]) => { const s = [...xs].sort((a, b) => a - b); const m = s.length >> 1; return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2 }

console.log(`\n━━━ §4 · what a CRON week needs TODAY (ratio ${SQP_COMPLETENESS_RATIO}, baseline ${SQP_BASELINE_PERIODS}) ━━━`)
// measured yield per report, from the ledger
const YIELD: Record<string, number> = { IT: 6.00, ES: 4.00, DE: 0.80, FR: 0.10 }
const POOL: Record<string, number> = { IT: 250, ES: 121, DE: 208, FR: 113 }
console.log('mkt  baseline  threshold   cronRows  rows/report  reportsNeeded   poolMax  poolCeilingRows  verdict')
for (const m of KT_MARKETS) {
  const series = weeks.map((w) => rowsOf(w, m)).filter((r) => r > 0)
  const base = median(series.slice(0, SQP_BASELINE_PERIODS))
  const thr = SQP_COMPLETENESS_RATIO * base
  const cron = rowsOf(weeks[0]!, m)
  const need = Math.ceil(thr / YIELD[m]!)
  const ceilRows = POOL[m]! * YIELD[m]!
  const verdict = ceilRows >= thr ? `needs ${need} reports` : `🔴 IMPOSSIBLE — whole pool yields ${ceilRows.toFixed(0)} < ${thr}`
  console.log(`${m.padEnd(4)} ${String(base).padStart(8)} ${String(thr).padStart(10)} ${String(cron).padStart(10)} ${YIELD[m]!.toFixed(2).padStart(12)} ${String(need).padStart(14)} ${String(POOL[m]).padStart(9)} ${ceilRows.toFixed(0).padStart(16)}  ${verdict}`)
}

console.log('\n━━━ §4 · the baseline FALLING — simulate weeks forward at the current budget ━━━')
console.log('Each new cron week enters the 12-period baseline and pushes the oldest out. Backfill weeks')
console.log('leave the baseline by being displaced, and leave the 42d LOOKBACK by ageing.\n')
for (const m of KT_MARKETS) {
  const series = weeks.map((w) => ({ w, rows: rowsOf(w, m) })).filter((p) => p.rows > 0)
  const cronRows = rowsOf(weeks[0]!, m)   // what a nightly week produces today
  let sim = [...series]
  const out: string[] = []
  for (let k = 1; k <= 10; k++) {
    const nextW = new Date(Date.parse(weeks[0]! + 'T00:00:00Z') + k * 7 * 86_400_000).toISOString().slice(0, 10)
    sim = [{ w: nextW, rows: cronRows }, ...sim]
    const base = median(sim.slice(0, SQP_BASELINE_PERIODS).map((p) => p.rows))
    const thr = SQP_COMPLETENESS_RATIO * base
    out.push(`${nextW}:thr=${thr.toFixed(0)}${cronRows >= thr ? ' PASS' : ''}`)
  }
  const firstPass = out.findIndex((o) => o.includes('PASS'))
  console.log(`  ${m} (cron week = ${cronRows} rows): ${out.slice(0, 8).join('  ')}`)
  console.log(`     ⇒ ${firstPass >= 0 ? `passes unaided from ${out[firstPass]!.split(':')[0]}` : 'never passes within 10 weeks at this budget'}`)
}

console.log('\n━━━ §5.5 · median over CRON-FED weeks only, costed ━━━━━━━━━━━━━━━━━━━━━━')
console.log('Compare like with like: baseline = median of weeks whose distinct-ASIN count says cron.')
for (const m of KT_MARKETS) {
  const cronWeeks = weeks.filter((w) => KT_MARKETS.reduce((s, mm) => s + asinsOf(w, mm), 0) <= 48)
  const cronSeries = cronWeeks.map((w) => rowsOf(w, m)).filter((r) => r > 0)
  if (!cronSeries.length) { console.log(`  ${m}: no cron weeks yet`); continue }
  const base = median(cronSeries)
  const thr = SQP_COMPLETENESS_RATIO * base
  const newest = rowsOf(weeks[0]!, m)
  console.log(`  ${m}: cron weeks ${JSON.stringify(cronSeries)} → median ${base} · threshold ${thr} · newest ${newest} ⇒ ${newest >= thr ? '✓ PASSES TODAY' : '✗ still fails'}`)
}

console.log('\n━━━ §6.6 · the operator-visible reach line, per market ━━━━━━━━━━━━━━━━━━━')
for (const m of KT_MARKETS) {
  const periods = weeks.map((w) => ({ start: new Date(w + 'T00:00:00Z'), rows: rowsOf(w, m) })).filter((p) => p.rows > 0)
  const c = chooseViewPeriod(periods as any)
  const wk = c.start ? new Date(c.start).toISOString().slice(0, 10) : null
  const ageD = wk ? ((Date.now() - Date.parse(wk + 'T00:00:00Z')) / 86_400_000).toFixed(0) : '—'
  console.log(`  ${m}: gate picks ${wk} (${ageD}d) · share measured across ${wk ? asinsOf(wk, m) : 0} ASINs · ${c.reason}`)
}
await prisma.$disconnect()
