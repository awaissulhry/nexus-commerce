/**
 * SQP.3 Phase C — the yield curve, take 2.
 *
 * The first attempt created the reports and then crashed parsing them: report documents are GZIP, and
 * a bare fetch() returns compressed bytes. The collector uses `sp.download(docRes)`, which handles it —
 * so this reuses that path instead of hand-rolling, and recovers the reports already created via
 * listReports rather than paying the ~65s createReport throttle six more times.
 */
import prisma from '../src/db.js'
import { parseSqp, SQP_REPORT_TYPE, periodWindow, SQP_LOOKBACK } from '../src/services/advertising/sqp.service.js'
import { getSpApiClient } from '../src/services/sp-api-reports.service.js'

const sp = getSpApiClient()
const win = periodWindow('WEEK', new Date(), SQP_LOOKBACK)
const since = new Date(Date.now() - 3 * 3600_000)

// The ASINs the crashed run created reports for, plus DE's — recovered from the log.
const TESTED = new Set(['B0DJ4FLPHM', 'B0F5GLQ86P', 'B0BTC94BQQ'])

const list: any = await (sp as any).callAPI({
  operation: 'getReports', endpoint: 'reports',
  query: { reportTypes: [SQP_REPORT_TYPE], createdSince: since.toISOString(), pageSize: 100 },
})
const reports: any[] = list?.reports ?? []
console.log(`━━━ ${reports.length} ${SQP_REPORT_TYPE} reports created in the last 3h ━━━`)

const rows: Array<{ asin: string; mkt: string; rows: number; imp: number; bytes: number }> = []
for (const r of reports) {
  const asin = r?.reportOptions?.asin
  if (!asin || !TESTED.has(asin)) continue
  if (r.processingStatus !== 'DONE' || !r.reportDocumentId) { console.log(`  ${asin}: ${r.processingStatus}`); continue }
  const docRes: any = await (sp as any).callAPI({ operation: 'getReportDocument', endpoint: 'reports', path: { reportDocumentId: r.reportDocumentId } })
  const raw: string = typeof docRes === 'string' ? docRes : await (sp as any).download(docRes)
  let payload: unknown
  try { payload = JSON.parse(raw) } catch { payload = raw }
  const parsed = parseSqp(payload)
  const imp = parsed.reduce((s: number, x: any) => s + (x.impressionsTotal ?? 0), 0)
  const mkt = r?.marketplaceIds?.[0] ?? '?'
  rows.push({ asin, mkt, rows: parsed.length, imp, bytes: raw.length })
  console.log(`  ${asin}: ${parsed.length} rows · ${raw.length} bytes · ${imp} market impressions`)
}

console.log('\n━━━ verdict — do never-fetched ASINs return data? ━━━━━━━━━━━━━━━━━━━━━━━━━')
const withRows = rows.filter((r) => r.rows > 0)
const total = rows.reduce((s, r) => s + r.rows, 0)
console.log(`  ${withRows.length} of ${rows.length} never-fetched ASINs returned rows · ${total} rows total`)
if (rows.length) {
  console.log(`  mean ${(total / rows.length).toFixed(1)} rows/ASIN · median ${[...rows].sort((a,b)=>a.rows-b.rows)[Math.floor(rows.length/2)]!.rows}`)
  console.log(withRows.length === 0
    ? '  ⇒ 🔴 widening the ASIN count would add reports and NO data. Widen WEEKS instead.'
    : `  ⇒ widening the ASIN count DOES add data. The tail was unsampled, not barren.`)
}
console.log(`\n  for scale, the current top-10 in the same week hold ${await prisma.searchQueryPerformance.count({ where: { reportPeriod: 'WEEK', startDate: win.start } })} rows`)
console.log('  (nothing written to SearchQueryPerformance — parses and counts only)')
await prisma.$disconnect()
