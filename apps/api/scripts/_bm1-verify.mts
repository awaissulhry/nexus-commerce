/** BM.1 — run the real registry through runReport() against prod. READ-ONLY. */
import { resolve } from 'path'; import { config } from 'dotenv'
config(); config({ path: resolve('/Users/awais/nexus-commerce/.env') })
const { runReport } = await import('../src/services/advertising/ads-report-runner.service.js')
const { REPORT_SPECS } = await import('../src/services/advertising/ads-report-specs.js')

const spec = REPORT_SPECS['brand-metrics']
console.log('metrics in the spec:', spec.metrics.length)
const ids = spec.metrics.map(m => m.id)
console.log('ids:', ids.join(', '), '\n')

const r = await runReport({
  reportId: 'brand-metrics',
  from: '2026-06-01', to: '2026-08-31',
  marketplaces: ['IT'],
  groupBy: ['categoryNodeName'],
  columns: ids,
  page: 1, pageSize: 50,
})
console.log(`rows ${r.rows.length} · total ${r.total} · ${r.elapsedMs}ms\n`)
const root = r.rows.find(x => String(x.categoryNodeName).split('/').length === 3)
console.log('ROOT NODE:', root?.categoryNodeName, '\n')
for (const m of spec.metrics) {
  const v = root?.[m.id]
  console.log(`  ${m.id.padEnd(42)} ${v === null || v === undefined ? '— (null)' : String(v)}`)
}
