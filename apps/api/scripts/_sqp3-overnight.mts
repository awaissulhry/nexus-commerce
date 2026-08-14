/** SQP.3 — what the nightly passes actually DID under the new code. Judged by what they wrote. */
import prisma from '../src/db.js'
import { periodWindow, SQP_LOOKBACK } from '../src/services/advertising/sqp.service.js'
import { settledAsins } from '../src/services/advertising/sqp-async.service.js'

const since = new Date(Date.now() - 14 * 3600_000)
for (const job of ['sqp-ingest', 'sqp-collect']) {
  const runs = await prisma.cronRun.findMany({
    where: { jobName: job, startedAt: { gte: since } },
    select: { startedAt: true, status: true, outputSummary: true, errorMessage: true },
    orderBy: { startedAt: 'desc' }, take: 4,
  })
  console.log(`━━━ ${job} · ${runs.length} runs in 14h ━━━`)
  for (const r of runs) {
    console.log(`  ${r.startedAt.toISOString().slice(5,16)} ${r.status}`)
    if (r.outputSummary) console.log(`     ${r.outputSummary.slice(0, 300)}`)
    if (r.errorMessage) console.log(`     🔴 err: ${r.errorMessage.slice(0, 260)}`)
  }
}

const win = periodWindow('WEEK', new Date(), SQP_LOOKBACK)
console.log(`\n━━━ the active week ${win.start.toISOString().slice(0,10)} ━━━`)
const rows = await prisma.sqpReportRequest.findMany({
  where: { reportPeriod: 'WEEK', startDate: win.start },
  select: { asin: true, marketplace: true, status: true, collectedAt: true, rowsChanged: true, rowsUpserted: true },
  orderBy: { requestedAt: 'asc' },
})
console.log(`  ${rows.length} requests · statuses: ${[...new Set(rows.map(r=>r.status))].join(',')}`)
const byM = new Map<string, number>()
for (const r of rows) byM.set(r.marketplace, (byM.get(r.marketplace) ?? 0) + 1)
console.log('  by market:', [...byM].map(([m,n])=>`${m}=${n}`).join(' '))
const s = settledAsins(rows)
console.log(`  settled now (20h guard): ${s.size}${s.size ? ' → ' + [...s].join(',') : ''}`)
console.log('  stored SQP rows in this week:', await prisma.searchQueryPerformance.count({ where: { reportPeriod: 'WEEK', startDate: win.start } }))
console.log('  newest week stored anywhere:', (await prisma.searchQueryPerformance.aggregate({ _max: { startDate: true } }))._max.startDate?.toISOString().slice(0,10))
await prisma.$disconnect()
