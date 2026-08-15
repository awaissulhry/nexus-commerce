/** The first nightly pass under SQP.5's dormancy + KT.10's page. Read-only. */
import '../src/env.js'
import prisma from '../src/db.js'
import { getKeywordTracker, KT_MARKETS } from '../src/services/advertising/keyword-tracker.service.js'

for (const job of ['sqp-ingest', 'sqp-collect']) {
  const runs = await prisma.cronRun.findMany({
    where: { jobName: job, startedAt: { gte: new Date(Date.now() - 30 * 3600_000) } },
    select: { startedAt: true, status: true, outputSummary: true, errorMessage: true },
    orderBy: { startedAt: 'desc' }, take: 3,
  })
  console.log(`━━━ ${job} · ${runs.length} runs in 30h ━━━`)
  for (const r of runs) {
    console.log(`  ${r.startedAt.toISOString().slice(5, 16)} ${r.status}`)
    if (r.outputSummary) console.log(`     ${r.outputSummary.slice(0, 320)}`)
    if (r.errorMessage) console.log(`     🔴 ${r.errorMessage.slice(0, 200)}`)
  }
}
const st = await prisma.sqpReportRequest.groupBy({ by: ['status'], _count: { _all: true } })
console.log(`\nSqpReportRequest: ${st.map((s) => `${s.status}=${s._count._all}`).join(' ')}`)
const wk = await prisma.searchQueryPerformance.findMany({
  where: { reportPeriod: 'WEEK' }, select: { startDate: true }, distinct: ['startDate'], orderBy: { startDate: 'desc' }, take: 2,
})
console.log(`newest stored week: ${wk.map((w) => w.startDate.toISOString().slice(0, 10)).join(' · ')}`)

console.log('\n━━━ what the page reads now ━━━')
for (const market of KT_MARKETS) {
  const d: any = await getKeywordTracker({ market } as any)
  const w = d.window, m = w.market
  const measured = (d.rows ?? []).filter((r: any) => r.measured === true && r.impressionShare != null)
  const inv = measured.filter((r: any) => r.asOf?.slice(0, 10) !== w.period?.slice(0, 10))
  console.log(`  ${market}: ${w.period} (${w.periodAgeDays}d) · ${w.asins} ASINs · ${measured.length} measured · ${w.reason}${w.truncated ? ' TRUNCATED' : ''} · INVERSIONS ${inv.length}`)
  console.log(`      market: ${m ? `vs ${m.priorPeriod} on ${m.pairs} pairs · vol ${m.volumeDeltaPct?.toFixed(0)}% · share ${m.sharePriorPct?.toFixed(3)}%→${m.shareNowPct?.toFixed(3)}% · settled=${m.newestIsSettled}` : 'null (below the 5-pair floor)'}`)
}
await prisma.$disconnect()
