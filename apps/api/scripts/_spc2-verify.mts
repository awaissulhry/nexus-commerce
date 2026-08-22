/** SPC.2 — does every new metric's SQL execute against prod? READ-ONLY. */
import { resolve } from 'path'; import { config } from 'dotenv'
config(); config({ path: resolve('/Users/awais/nexus-commerce/.env') })
const { runReport } = await import('../src/services/advertising/ads-report-runner.service.js')
const { REPORT_SPECS } = await import('../src/services/advertising/ads-report-specs.js')

const spec = REPORT_SPECS.campaign
console.log('campaign spec — metrics:', spec.metrics.length, '· dimensions:', spec.dimensions.length)

const ids = spec.metrics.map(m => m.id)
const r = await runReport({
  reportId: 'campaign', from: '2026-08-18', to: '2026-08-18',
  marketplaces: ['IT'], groupBy: ['campaign'], columns: ids, page: 1, pageSize: 5,
})
console.log(`ran in ${r.elapsedMs}ms · ${r.total} groups\n`)
const row = r.rows[0] as Record<string, unknown>
for (const m of spec.metrics) {
  const v = row?.[m.id]
  const tag = v === null || v === undefined ? 'NULL (not ingested yet)' : String(v)
  console.log(`  ${m.id.padEnd(24)} ${m.format.padEnd(6)} ${tag}`)
}
// Every metric must appear in the totals row too — that is the export/grid contract.
const missingFromTotals = ids.filter(id => !(id in (r.totals ?? {})))
console.log('\nmetrics missing from the totals row:', missingFromTotals.length ? missingFromTotals : 'none')
console.log('dimension check — the two identity columns:',
  spec.dimensions.filter(d => ['campaignNameAmazon','campaignStatusThen'].includes(d.id)).map(d => d.id))
