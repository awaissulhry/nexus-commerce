/**
 * SQP.3 Phase C — the yield distribution of the ACTUAL nightly pass.
 *
 * Better than the 3-ASIN test I set out to run: every Brand Analytics document generated in the last
 * 12h is the production pass plus my probes, so this measures what our real selection returns per
 * report — the number the widening decision actually needs.
 *
 * 334 bytes is the literal empty payload (`"dataByAsin": []`), first seen in SQP.2.
 */
import prisma from '../src/db.js'
import { parseSqp, SQP_REPORT_TYPE, periodWindow, SQP_LOOKBACK } from '../src/services/advertising/sqp.service.js'
import { getSpApiClient } from '../src/services/sp-api-reports.service.js'

const sp = getSpApiClient()
const win = periodWindow('WEEK', new Date(), SQP_LOOKBACK)
const list: any = await (sp as any).callAPI({
  operation: 'getReports', endpoint: 'reports',
  query: { reportTypes: [SQP_REPORT_TYPE], createdSince: new Date(Date.now() - 12 * 3600_000).toISOString(), pageSize: 100 },
})
const done = (list?.reports ?? []).filter((r: any) => r.processingStatus === 'DONE' && r.reportDocumentId)
const byDoc = new Map<string, any>()
for (const r of done) if (!byDoc.has(r.reportDocumentId)) byDoc.set(r.reportDocumentId, r)
console.log(`${done.length} DONE reports → ${byDoc.size} distinct documents (Amazon dedups identical requests)`)

const rows: Array<{ mkt: string; rows: number; imp: number; bytes: number; asin: string | null }> = []
for (const [id, r] of byDoc) {
  try {
    const docRes: any = await (sp as any).callAPI({ operation: 'getReportDocument', endpoint: 'reports', path: { reportDocumentId: id } })
    const raw: string = typeof docRes === 'string' ? docRes : await (sp as any).download(docRes)
    let payload: unknown
    try { payload = JSON.parse(raw) } catch { payload = raw }
    const parsed = parseSqp(payload)
    rows.push({
      mkt: r.marketplaceIds?.[0] ?? '?', rows: parsed.length, bytes: raw.length,
      imp: parsed.reduce((s: number, x: any) => s + (x.impressionsTotal ?? 0), 0),
      asin: (parsed.find((p: any) => p.asin)?.asin) ?? null,
    })
  } catch (e) { console.log(`  ${id.slice(-20)} FAILED: ${(e as Error).message.slice(0, 60)}`) }
}

const empty = rows.filter((r) => r.rows === 0)
const nonEmpty = rows.filter((r) => r.rows > 0).sort((a, b) => b.rows - a.rows)
console.log(`\n━━━ yield per report ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`)
console.log(`  documents examined: ${rows.length}`)
console.log(`  🔴 EMPTY (0 rows): ${empty.length} of ${rows.length} = ${(100*empty.length/Math.max(1,rows.length)).toFixed(0)}%`)
console.log(`  with data: ${nonEmpty.length} → ${nonEmpty.map((r) => `${r.asin ?? '?'}:${r.rows}`).join(' ')}`)
console.log(`  total rows across every report: ${rows.reduce((s, r) => s + r.rows, 0)}`)
console.log(`  mean ${(rows.reduce((s,r)=>s+r.rows,0)/Math.max(1,rows.length)).toFixed(2)} rows/report · median ${[...rows].sort((a,b)=>a.rows-b.rows)[Math.floor(rows.length/2)]?.rows ?? 0}`)
const byMkt = new Map<string, { n: number; rows: number }>()
for (const r of rows) { const c = byMkt.get(r.mkt) ?? { n: 0, rows: 0 }; c.n++; c.rows += r.rows; byMkt.set(r.mkt, c) }
console.log('  by marketplaceId:', [...byMkt].map(([m, c]) => `${m} ${c.rows}r/${c.n}rep`).join(' · '))
console.log(`\n  stored in this week now: ${await prisma.searchQueryPerformance.count({ where: { reportPeriod: 'WEEK', startDate: win.start } })} rows`)
console.log('  (read-only — parses and counts, writes nothing)')
await prisma.$disconnect()
