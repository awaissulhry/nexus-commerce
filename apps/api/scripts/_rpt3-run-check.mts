import { resolve } from 'path'
import { config } from 'dotenv'
config(); config({ path: resolve(new URL('.', import.meta.url).pathname, '../../../.env') })
const { runReport } = await import('../src/services/advertising/ads-report-runner.service.js')
const { RUNNABLE_REPORT_IDS } = await import('../src/services/advertising/ads-report-specs.js')
const fmt = (v: unknown) => v == null ? '—' : typeof v === 'number' ? (Number.isInteger(v) ? v.toLocaleString('en-GB') : v.toFixed(4)) : String(v).slice(0, 28)
for (const id of RUNNABLE_REPORT_IDS) {
  try {
    const r = await runReport({ reportId: id, from: '2026-01-01', to: '2026-12-31', page: 1, pageSize: 3 })
    console.log(`\n=== ${id}  (${r.total} groups · ${r.elapsedMs}ms · ${r.applied.groupBy.join('+')})`)
    console.log('   ' + r.columns.map(c => c.label).join(' | '))
    for (const row of r.rows) console.log('   ' + r.columns.map(c => fmt(row[c.id])).join(' | '))
    if (r.totals) console.log('   TOTALS: ' + r.columns.filter(c=>c.kind==='metric').map(c => `${c.id}=${fmt(r.totals![c.id])}`).join(' '))
    console.log('   filters: markets=' + r.options.marketplaces.join('/') + ' adProducts=' + r.options.adProducts.join('/'))
  } catch (e) { console.log(`\n=== ${id}  ❌ ${(e as Error).message.split('\n')[0]}`) }
}
process.exit(0)
