import { resolve } from 'path'; import { config } from 'dotenv'
config(); config({ path: resolve(new URL('.', import.meta.url).pathname, '../../../.env') })
const svc = await import('../src/services/advertising/ads-custom-metrics.service.js')
const { runReport } = await import('../src/services/advertising/ads-report-runner.service.js')
const { reportSummary } = await import('../src/services/advertising/ads-report-summary.service.js')

console.log('1. CREATE — a metric this console could not previously express')
const m1 = await svc.createCustomMetric({
  reportId: 'campaign', name: 'Contribution after ads',
  formula: 'sales - cost', format: 'money', betterWhen: 'higher',
  description: 'Attributed sales left after the ad spend that produced them',
})
const m2 = await svc.createCustomMetric({
  reportId: 'campaign', name: 'Profit per click',
  formula: '(sales - cost) / clicks', format: 'money', betterWhen: 'higher',
})
console.log(`   ${m1.name} → ${m1.id ? 'saved' : ''} uses [${m1.usedMetrics}]`)
console.log(`   ${m2.name} → uses [${m2.usedMetrics}]`)

console.log('\n2. REFUSALS')
for (const [label, f] of [['unknown metric','sales - profit'],['injection','sales; DROP TABLE "Campaign"'],['constant only','42'],['unbalanced','(sales'],['shadows a built-in','sales']] as Array<[string,string]>) {
  try { await svc.createCustomMetric({ reportId: 'campaign', name: label === 'shadows a built-in' ? 'Sales' : `t_${label}`, formula: f }); console.log(`   ${label.padEnd(20)} ACCEPTED (!)`) }
  catch (e) { console.log(`   ${label.padEnd(20)} ${(e as Error).message}`) }
}

console.log('\n3. THE GRID — custom metrics are ordinary columns')
const cid = (n: string) => svc.customMetricId(n)
const r = await runReport({ reportId: 'campaign', from: '2026-07-05', to: '2026-08-03',
  columns: ['campaign','sales','cost',cid('Contribution after ads'),cid('Profit per click')], page: 1, pageSize: 4 })
console.log('   ' + r.columns.map(c=>c.label).join(' | '))
for (const row of r.rows) console.log('   ' + r.columns.map(c=>{const v=row[c.id]; return v==null?'—':typeof v==='number'?v.toFixed(2):String(v).slice(0,22)}).join(' | '))
console.log('   TOTALS: ' + r.columns.filter(c=>c.kind==='metric').map(c=>`${c.label}=${r.totals?.[c.id]}`).join('  '))

console.log('\n4. ARITHMETIC HOLDS AT THE TOTAL (aggregate, not per-row)')
const t = r.totals as Record<string, number>
const contrib = t[cid('Contribution after ads')], sales = t['sales'], cost = t['cost']
console.log(`   sales ${sales} - cost ${cost} = ${(sales-cost).toFixed(2)}  ·  metric says ${Number(contrib).toFixed(2)}  ${Math.abs((sales-cost)-contrib)<0.01?'✓ match':'✗ MISMATCH'}`)

console.log('\n5. KPI TILES SEE THE SAME REGISTRY')
const s = await reportSummary({ reportId: 'campaign', from: '2026-07-05', to: '2026-08-03',
  metrics: ['sales','cost',cid('Contribution after ads')], compare: 'previous' })
for (const k of s.metrics) console.log(`   ${k.label.padEnd(24)} ${String(k.current).padStart(12)}  betterWhen=${k.betterWhen}`)

console.log('\n6. IT IS EXPORTABLE TOO')
const { exportReport } = await import('../src/services/advertising/ads-report-export.service.js')
const out = await exportReport({ reportId: 'campaign', from: '2026-07-05', to: '2026-08-03',
  columns: ['campaign', cid('Contribution after ads')], page: null }, 'csv')
console.log('   ' + out.body.toString('utf8').split('\r\n').slice(0,3).join('\n   '))
console.log('   manifest unit:', out.manifest.columns.find(c=>/Contribution/.test(c.label))?.unit)

for (const m of [m1, m2]) await svc.deleteCustomMetric(m.id)
console.log('\n   test metrics removed')
process.exit(0)
