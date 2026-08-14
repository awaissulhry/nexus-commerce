/**
 * SQP.3 Phase C — the yield curve where it actually matters: ASINs we have NEVER fetched.
 *
 * §3 of _sqp3-yield showed rank 11+ holding MORE rows than the top 10, but that measures fetch
 * history, not intrinsic yield — those rows exist because some earlier run used a larger limit. The
 * only honest test is to ask Amazon for ASINs that have no rows at all and count what comes back.
 */
import prisma from '../src/db.js'
import { ourAsinsForMarketplace, periodWindow, SQP_LOOKBACK, parseSqp, SQP_REPORT_TYPE } from '../src/services/advertising/sqp.service.js'
import { getSpApiClient } from '../src/services/sp-api-reports.service.js'

const win = periodWindow('WEEK', new Date(), SQP_LOOKBACK)
const MKTS = (process.env.YIELD_MKTS || 'IT,DE').split(',')
const N = Number(process.env.YIELD_N || 3)

console.log('━━━ FR: why it looks different ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
for (const m of ['DE', 'ES', 'FR', 'IT']) {
  const rows = await prisma.channelListing.findMany({
    where: { channel: 'AMAZON', OR: [{ marketplace: m }, { region: m }] },
    select: { listingStatus: true }, take: 1000,
  })
  const st = new Map<string, number>()
  for (const r of rows) st.set(r.listingStatus ?? 'null', (st.get(r.listingStatus ?? 'null') ?? 0) + 1)
  const active = st.get('ACTIVE') ?? 0
  console.log(`  ${m}: ${[...st].map(([k, v]) => `${k}=${v}`).join(' ')}${active === 0 ? '   🔴 ZERO ACTIVE — the "active first" ordering is inert here' : ''}`)
}

console.log('\n━━━ the real yield curve: never-fetched ASINs, asked directly ━━━━━━━━━━━━━━')
const sp = getSpApiClient()
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const results: Array<{ mkt: string; asin: string; rows: number; bytes: number; impressions: number }> = []

for (const m of MKTS) {
  const mk = await prisma.marketplace.findFirst({ where: { code: m, channel: 'AMAZON' }, select: { marketplaceId: true } })
  if (!mk?.marketplaceId) continue
  const pool = await ourAsinsForMarketplace(m, 200)
  const never: string[] = []
  for (const a of pool) {
    if (never.length >= N) break
    const c = await prisma.searchQueryPerformance.count({ where: { marketplace: m, asin: a } })
    const req = await prisma.sqpReportRequest.count({ where: { marketplace: m, asin: a } })
    if (c === 0 && req === 0) never.push(a)
  }
  console.log(`  ${m}: pool ${pool.length} · testing ${never.length} never-fetched: ${never.join(', ')}`)

  const ids: Array<{ asin: string; reportId: string }> = []
  for (const asin of never) {
    const res: any = await (sp as any).callAPI({
      operation: 'createReport', endpoint: 'reports',
      body: { reportType: SQP_REPORT_TYPE, marketplaceIds: [mk.marketplaceId], dataStartTime: win.start.toISOString(), dataEndTime: win.end.toISOString(), reportOptions: { reportPeriod: 'WEEK', asin } },
    })
    if (res?.reportId) ids.push({ asin, reportId: res.reportId })
  }
  for (const { asin, reportId } of ids) {
    let doc: string | null = null
    for (let i = 0; i < 40; i++) {
      await sleep(15_000)
      const r: any = await (sp as any).callAPI({ operation: 'getReport', endpoint: 'reports', path: { reportId } })
      if (r?.processingStatus === 'DONE') { doc = r.reportDocumentId; break }
      if (['FATAL', 'CANCELLED'].includes(r?.processingStatus)) break
    }
    if (!doc) { console.log(`     ${m} ${asin}: no document`); continue }
    const d: any = await (sp as any).callAPI({ operation: 'getReportDocument', endpoint: 'reports', path: { reportDocumentId: doc } })
    const text = await (await fetch(d.url)).text()
    const parsed = parseSqp(JSON.parse(text))
    const imp = parsed.reduce((s: number, r: any) => s + (r.impressionsTotal ?? 0), 0)
    results.push({ mkt: m, asin, rows: parsed.length, bytes: text.length, impressions: imp })
    console.log(`     ${m} ${asin}: ${parsed.length} rows · ${text.length} bytes · ${imp} market impressions`)
  }
}

console.log('\n━━━ verdict ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
const withRows = results.filter((r) => r.rows > 0)
console.log(`  ${withRows.length} of ${results.length} never-fetched ASINs returned rows · total ${results.reduce((s, r) => s + r.rows, 0)} rows`)
console.log(results.length && withRows.length === 0
  ? '  ⇒ widening the ASIN count would add reports and no data. Widen WEEKS instead.'
  : `  ⇒ widening the ASIN count DOES add data (mean ${(results.reduce((s,r)=>s+r.rows,0)/Math.max(1,results.length)).toFixed(1)} rows/ASIN).`)
console.log('  (nothing written to SearchQueryPerformance — this only parses and counts)')
await prisma.$disconnect()
