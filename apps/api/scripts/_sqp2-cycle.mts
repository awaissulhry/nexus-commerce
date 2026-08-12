/**
 * _sqp2-cycle.mts — SQP.2 Phase D verification: exercise the REAL request and collect passes.
 *
 * 🔴 CALLS AMAZON and WRITES. `--request` creates ONE report for ONE ASIN in ONE market — the
 *    smallest thing that can prove the wiring — and records it in SqpReportRequest. `--collect` runs
 *    the real collect pass. Neither widens anything: one ASIN is a subset of what the nightly cron
 *    already asks for.
 *
 * Run:
 *   railway run --service "@nexus/api" env -u REDIS_URL NEXUS_AMAZON_ADS_QUOTA_MODE=off \
 *     npx tsx scripts/_sqp2-cycle.mts [--request|--collect|--state]
 */
import '../src/env.js'
import prisma from '../src/db.js'
import { requestSqpReports, collectSqpReports } from '../src/services/advertising/sqp-async.service.js'
import { periodWindow, ourAsinsForMarketplace } from '../src/services/advertising/sqp.service.js'

const mode = process.argv.find((a) => a.startsWith('--')) ?? '--state'

async function state() {
  const g = await prisma.sqpReportRequest.groupBy({ by: ['status'], _count: { _all: true } })
  console.log(`SqpReportRequest states: ${g.map((x) => `${x.status}=${x._count._all}`).join(' · ') || '(none)'}`)
  const rows = await prisma.sqpReportRequest.findMany({ orderBy: { requestedAt: 'desc' }, take: 12 })
  for (const r of rows) {
    const ageM = ((Date.now() - +r.requestedAt) / 60_000).toFixed(1)
    console.log(`  ${r.reportId} ${r.marketplace} ${r.asin} ${r.startDate.toISOString().slice(0, 10)} ${r.status} age=${ageM}m polls=${r.pollAttempts}${r.rowsUpserted != null ? ` rows=${r.rowsUpserted}` : ''}${r.errorMessage ? ` ⚠ ${r.errorMessage.slice(0, 70)}` : ''}`)
  }
}

async function main() {
  if (mode === '--request') {
    const mkt = 'ES' // ES has the best SQP coverage (7 of 10 requested ASINs return rows), so a
                     // non-empty document is the likely outcome and the ingest path gets exercised.
    const mkRow = await prisma.marketplace.findUnique({ where: { channel_code: { channel: 'AMAZON', code: mkt } }, select: { marketplaceId: true } })
    const asins = (await ourAsinsForMarketplace(mkt, 10)).slice(0, 1)
    const win = periodWindow('WEEK', new Date(), 2)
    console.log(`requesting 1 report: ${mkt} ${asins[0]} week ${win.start.toISOString().slice(0, 10)}`)
    const r = await requestSqpReports({ marketplaceCode: mkt, marketplaceId: mkRow!.marketplaceId!, asins, period: 'WEEK', start: win.start, end: win.end })
    console.log('result:', JSON.stringify(r))
  } else if (mode === '--collect') {
    const r = await collectSqpReports({ limit: 20, paceMs: 1_200 })
    console.log('collect:', JSON.stringify(r))
  }
  await state()
  console.log(`SearchQueryPerformance total = ${await prisma.searchQueryPerformance.count()}`)
}
main().then(() => prisma.$disconnect()).catch(async (e) => { console.error(e); await prisma.$disconnect(); process.exit(1) })
