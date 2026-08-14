/**
 * SQP.4 — the live proof: the SAME budget, aimed at ASINs proven to return rows.
 *
 * Not a widening. Requests at most one nightly pass worth (40), targeting the current week only, and
 * skipping anything already requested for it. Uses requestSqpReports/collectSqpReports so every report
 * is recorded in the ledger with its own row count.
 */
import prisma from '../src/db.js'
import { periodWindow, SQP_LOOKBACK } from '../src/services/advertising/sqp.service.js'
import { requestSqpReports, collectSqpReports } from '../src/services/advertising/sqp-async.service.js'

const KT = ['IT', 'DE', 'ES', 'FR']
const HIST = ['2026-07-12', '2026-07-05', '2026-06-28', '2026-06-21', '2026-06-14'].map((d) => new Date(d + 'T00:00:00Z'))
const PER_MARKET = Number(process.env.AIM_N || 10)
const win = periodWindow('WEEK', new Date(), SQP_LOOKBACK)
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

let created = 0
for (const m of KT) {
  const mk = await prisma.marketplace.findFirst({ where: { code: m, channel: 'AMAZON' }, select: { marketplaceId: true } })
  if (!mk?.marketplaceId) continue
  const hist = await prisma.sqpReportRequest.findMany({
    where: { marketplace: m, reportPeriod: 'WEEK', startDate: win.start }, select: { asin: true },
  })
  const already = new Set(hist.map((h) => h.asin))
  const ranked = (await prisma.searchQueryPerformance.groupBy({
    by: ['asin'], where: { reportPeriod: 'WEEK', marketplace: m, startDate: { in: HIST } }, _count: { _all: true },
  })).filter((h) => h.asin).map((h) => ({ asin: h.asin!, rows: h._count._all })).sort((a, b) => b.rows - a.rows)
  const pick = ranked.filter((r) => !already.has(r.asin)).slice(0, PER_MARKET).map((r) => r.asin)
  if (!pick.length) { console.log(`${m}: nothing new to aim at`); continue }
  console.log(`${m}: requesting ${pick.length} proven ASINs — ${pick.join(' ')}`)
  const r = await requestSqpReports({ marketplaceCode: m, marketplaceId: mk.marketplaceId, asins: pick, period: 'WEEK', start: win.start, end: win.end })
  console.log(`   created=${r.created} failed=${r.failed} outstanding=${r.alreadyOutstanding} settled=${r.alreadySettled}`)
  created += r.created
}
console.log(`\n━━━ ${created} reports created (one nightly pass = 40). Collecting… ━━━`)
for (let i = 0; i < 60; i++) {
  await sleep(20_000)
  const c = await collectSqpReports({ limit: 60 })
  if (c.ingested) console.log(`  tick ${i}: ingested=${c.ingested} rows=${c.rowsUpserted} changed=${c.rowsChanged} pending=${c.stillPending}`)
  if (!c.stillPending && i > 2) break
}
const left = await prisma.sqpReportRequest.count({ where: { startDate: win.start, status: { in: ['PENDING', 'DONE'] } } })
console.log(`\noutstanding after collect: ${left}`)
await prisma.$disconnect()
