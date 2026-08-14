/** SQP.4 — §7 stop conditions and the data the model needs. Read-only. */
import prisma from '../src/db.js'
import { chooseViewPeriod, KT_MARKETS, KT_LOOKBACK_DAYS, SQP_COMPLETENESS_RATIO, SQP_BASELINE_PERIODS } from '../src/services/advertising/keyword-tracker.service.js'

console.log('━━━ §7 STOP CONDITIONS ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
const rt = await prisma.rankTarget.findMany({ select: { id: true, name: true, maxBiasPct: true } })
const nonNull = rt.filter((r) => r.maxBiasPct !== null)
console.log(`  RankTarget: ${rt.length} rows · maxBiasPct non-null: ${nonNull.length}${nonNull.length ? '  🔴 STOP' : '  ✓ all NULL'}`)
console.log(`  NEXUS_COVERAGE_ENGINE_MODE=[${process.env.NEXUS_COVERAGE_ENGINE_MODE ?? 'unset'}]${process.env.NEXUS_COVERAGE_ENGINE_MODE ? '  🔴 STOP' : '  ✓'}`)
console.log(`  NEXUS_SQP_ROTATION=[${process.env.NEXUS_SQP_ROTATION ?? 'unset'}]`)

const byStatus = await prisma.sqpReportRequest.groupBy({ by: ['status'], _count: { _all: true } })
const nonTerminal = byStatus.filter((s) => s.status === 'PENDING' || s.status === 'DONE')
console.log(`  SqpReportRequest: ${byStatus.map((s) => `${s.status}=${s._count._all}`).join(' ')}${nonTerminal.length ? '  🔴 non-terminal present' : '  ✓ all terminal'}`)

const unfinished: any[] = await prisma.$queryRawUnsafe(
  `SELECT migration_name, started_at, finished_at, rolled_back_at FROM _prisma_migrations WHERE finished_at IS NULL ORDER BY started_at DESC LIMIT 5`)
console.log(`  _prisma_migrations unfinished: ${unfinished.length}${unfinished.length ? '  🔴 STOP — ' + unfinished.map((u) => u.migration_name).join(',') : '  ✓ zero'}`)

console.log('\n━━━ every stored week, by market ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
const g = await prisma.searchQueryPerformance.groupBy({
  by: ['startDate', 'marketplace'], where: { reportPeriod: 'WEEK' },
  _count: { _all: true }, orderBy: { startDate: 'desc' },
})
const weeks = [...new Set(g.map((r) => r.startDate.toISOString().slice(0, 10)))].sort().reverse()
const rowsOf = (w: string, m: string) => g.find((r) => r.startDate.toISOString().slice(0, 10) === w && r.marketplace === m)?._count._all ?? 0
// how many DISTINCT asins that week holds per market, and when it was first ingested
console.log('week        ' + KT_MARKETS.map((m) => m.padStart(6)).join('') + '   total   firstIngest  ageDays')
const now = Date.now()
for (const w of weeks) {
  const tot = KT_MARKETS.reduce((s, m) => s + rowsOf(w, m), 0)
  const fi = await prisma.searchQueryPerformance.aggregate({
    where: { reportPeriod: 'WEEK', startDate: new Date(w + 'T00:00:00Z') }, _min: { ingestedAt: true },
  })
  const age = ((now - Date.parse(w + 'T00:00:00Z')) / 86_400_000).toFixed(0)
  console.log(`${w}  ${KT_MARKETS.map((m) => String(rowsOf(w, m)).padStart(6)).join('')}  ${String(tot).padStart(6)}   ${fi._min.ingestedAt?.toISOString().slice(5, 10) ?? '—'}         ${age}`)
}

console.log(`\n━━━ the gate today (ratio ${SQP_COMPLETENESS_RATIO}, lookback ${KT_LOOKBACK_DAYS}d, baseline ${SQP_BASELINE_PERIODS} periods) ━━━`)
for (const m of KT_MARKETS) {
  const periods = weeks.map((w) => ({ start: new Date(w + 'T00:00:00Z'), rows: rowsOf(w, m) })).filter((p) => p.rows > 0)
  const c = chooseViewPeriod(periods as any)
  console.log(`  ${m}: picks ${c.start ? new Date(c.start).toISOString().slice(0,10) : 'none'} (${c.rows} rows) · baseline median ${c.baselineRows} · threshold ${c.threshold} · ${c.reason}${c.truncated ? ' TRUNCATED' : ''}`)
  console.log(`      rejected newer: ${c.rejected.map((r) => `${r.start}:${r.rows}`).join(' ') || '—'}`)
}
await prisma.$disconnect()
