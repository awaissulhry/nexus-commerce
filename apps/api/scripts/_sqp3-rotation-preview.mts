/**
 * SQP.3 Phase C — what NEXUS_SQP_ROTATION=1 would change tonight. Read-only, no Amazon calls.
 * This is the artefact the widening decision needs: the same budget, a different 40 ASINs.
 */
import prisma from '../src/db.js'
import { ourAsinsForMarketplace, periodWindow, SQP_LOOKBACK } from '../src/services/advertising/sqp.service.js'
import { selectNightlyAsins, selectionSummary } from '../src/services/advertising/sqp-selection.js'
import { settledAsins } from '../src/services/advertising/sqp-async.service.js'

const MKTS = ['DE', 'ES', 'FR', 'IT']
const BUDGET = 10
const win = periodWindow('WEEK', new Date(), SQP_LOOKBACK)
console.log(`active week ${win.start.toISOString().slice(0, 10)} · budget ${BUDGET}/market (unchanged)\n`)

let totalNew = 0, totalPool = 0, totalReq = 0
for (const m of MKTS) {
  const core = await ourAsinsForMarketplace(m, BUDGET)
  const pool = await ourAsinsForMarketplace(m, 250)
  const hist = await prisma.sqpReportRequest.groupBy({
    by: ['asin'], where: { marketplace: m, reportPeriod: 'WEEK', asin: { in: pool } }, _max: { requestedAt: true },
  })
  const lastAsked = new Map(hist.map((h) => [h.asin, h._max.requestedAt ?? null]))
  const forWeek = await prisma.sqpReportRequest.findMany({
    where: { marketplace: m, reportPeriod: 'WEEK', startDate: win.start, asin: { in: pool } },
    select: { asin: true, status: true, collectedAt: true, rowsChanged: true },
  })
  const sel = selectNightlyAsins({
    candidates: pool.map((asin, rank) => ({ asin, rank, lastRequestedAt: lastAsked.get(asin) ?? null })),
    budget: BUDGET, coreCount: BUDGET,
    settled: settledAsins(forWeek.filter((r) => r.status === 'INGESTED')),
    outstanding: new Set(forWeek.filter((r) => r.status === 'PENDING' || r.status === 'DONE').map((r) => r.asin)),
  })
  const everAsked = new Set(hist.map((h) => h.asin))
  const neverAsked = pool.filter((a) => !everAsked.has(a)).length
  console.log(`${m}: pool ${pool.length} · ever asked ${everAsked.size} · NEVER asked ${neverAsked}`)
  console.log(`   today  → ${core.join(' ')}`)
  console.log(`   rotate → ${selectionSummary(m, sel, pool.length)}`)
  const rot = sel.chosen.filter((a) => sel.reason[a] === 'rotation')
  if (rot.length) console.log(`   new tonight: ${rot.join(' ')}`)
  totalNew += neverAsked; totalPool += pool.length; totalReq += sel.chosen.length
}
console.log(`\n━━━ the widening decision, in numbers ━━━`)
console.log(`  pool across 4 markets: ${totalPool} ASINs · never asked once: ${totalNew} (${(100*totalNew/totalPool).toFixed(1)}%)`)
console.log(`  tonight's reports either way: ${totalReq} — rotation does NOT raise the budget`)
console.log(`  at ${BUDGET}/market/night, sweeping the whole pool takes ~${Math.ceil(totalPool / totalReq)} nights once slots free up`)
await prisma.$disconnect()
