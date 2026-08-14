/**
 * SQP.3 Phase C — the yield curve, from the documents already generated.
 *
 * Amazon DEDUPLICATES: two reportIds created 4.5 min apart for the same (asin, week) returned the same
 * reportDocumentId, so the 5 DONE reports are 3 distinct documents — the 3 never-fetched IT ASINs. No
 * further createReport calls are needed, which is the whole point of noticing the dedup.
 */
import prisma from '../src/db.js'
import { parseSqp, SQP_REPORT_TYPE, periodWindow, SQP_LOOKBACK } from '../src/services/advertising/sqp.service.js'
import { getSpApiClient } from '../src/services/sp-api-reports.service.js'

const sp = getSpApiClient()
const win = periodWindow('WEEK', new Date(), SQP_LOOKBACK)
const list: any = await (sp as any).callAPI({
  operation: 'getReports', endpoint: 'reports',
  query: { reportTypes: [SQP_REPORT_TYPE], createdSince: new Date(Date.now() - 4 * 3600_000).toISOString(), pageSize: 100 },
})
const docs = [...new Set((list?.reports ?? []).filter((r: any) => r.processingStatus === 'DONE' && r.reportDocumentId).map((r: any) => r.reportDocumentId))] as string[]
console.log(`━━━ ${docs.length} distinct documents from the never-fetched IT ASINs ━━━`)

const out: Array<{ rows: number; imp: number; bytes: number; asins: string[] }> = []
for (const id of docs) {
  try {
    const docRes: any = await (sp as any).callAPI({ operation: 'getReportDocument', endpoint: 'reports', path: { reportDocumentId: id } })
    const raw: string = typeof docRes === 'string' ? docRes : await (sp as any).download(docRes)
    let payload: unknown
    try { payload = JSON.parse(raw) } catch { payload = raw }
    const parsed = parseSqp(payload)
    const imp = parsed.reduce((s: number, x: any) => s + (x.impressionsTotal ?? 0), 0)
    const asins = [...new Set(parsed.map((p: any) => p.asin).filter(Boolean))] as string[]
    out.push({ rows: parsed.length, imp, bytes: raw.length, asins })
    console.log(`  ${id.slice(-26)}: ${parsed.length} rows · ${raw.length} bytes · ${imp} market impressions · asin ${asins.join(',') || '—'}`)
  } catch (e) {
    console.log(`  ${id.slice(-26)}: FAILED ${(e as Error).message.slice(0, 80)}`)
  }
}

console.log('\n━━━ verdict — do never-sampled ASINs return data? ━━━━━━━━━━━━━━━━━━━━━━━━━')
const withRows = out.filter((r) => r.rows > 0)
const total = out.reduce((s, r) => s + r.rows, 0)
console.log(`  ${withRows.length} of ${out.length} returned rows · ${total} rows · ${out.reduce((s,r)=>s+r.imp,0)} market impressions`)
if (out.length) console.log(`  mean ${(total / out.length).toFixed(1)} rows/ASIN`)
console.log(withRows.length === 0
  ? '  ⇒ 🔴 the tail IS barren. Widening the ASIN count adds reports and no data — widen WEEKS instead.'
  : '  ⇒ the tail was UNSAMPLED, not barren. Widening the ASIN count adds real data.')
const cur = await prisma.searchQueryPerformance.count({ where: { reportPeriod: 'WEEK', startDate: win.start } })
console.log(`\n  for scale: the whole current pass holds ${cur} rows in this week, from 40 reports.`)
console.log('  (nothing written to SearchQueryPerformance — parses and counts only)')
await prisma.$disconnect()
