import { resolve } from 'path'
import { config } from 'dotenv'
config(); config({ path: resolve(new URL('.', import.meta.url).pathname, '../../../.env') })
const { reportSummary, comparisonWindow, pickBucket } = await import('../src/services/advertising/ads-report-summary.service.js')

console.log('1. COMPARISON WINDOWS')
for (const [f,t] of [['2026-07-01','2026-07-31'],['2026-08-01','2026-08-04'],['2026-01-01','2026-12-31']] as Array<[string,string]>) {
  const prev = comparisonWindow('previous', f, t), yoy = comparisonWindow('yoy', f, t)
  const days=(a:string,b:string)=>Math.round((Date.parse(b)-Date.parse(a))/86400000)+1
  console.log(`   ${f}→${t} (${days(f,t)}d)  prev=${prev!.from}→${prev!.to} (${days(prev!.from,prev!.to)}d)  yoy=${yoy!.from}→${yoy!.to}  bucket=${pickBucket(f,t)}`)
}

console.log('\n2. KPI SUMMARY · campaign · last 30d vs previous 30d')
const s = await reportSummary({ reportId: 'campaign', from: '2026-07-05', to: '2026-08-03', compare: 'previous' })
console.log(`   window ${s.window.from}→${s.window.to}  vs  ${s.comparisonWindow!.from}→${s.comparisonWindow!.to}  · ${s.elapsedMs}ms · bucket=${s.bucket} · ${s.series.length} points`)
for (const m of s.metrics) {
  const d = m.deltaPct == null ? '   —   ' : `${m.deltaPct >= 0 ? '+' : ''}${(m.deltaPct*100).toFixed(1)}%`.padStart(8)
  const dir = m.betterWhen === null ? 'neutral' : m.betterWhen
  const good = m.deltaPct == null || m.betterWhen == null ? '' : ((m.deltaPct > 0) === (m.betterWhen === 'higher') ? '  ✓ better' : '  ✗ worse')
  console.log(`   ${m.label.padEnd(12)} ${String(m.current ?? '—').padStart(12)}  prev ${String(m.previous ?? '—').padStart(12)}  ${d}  [${dir}]${good}`)
}

console.log('\n3. DERIVED METRICS ARE RECOMPUTED PER PERIOD, NOT DIFFERENCED')
const acos = s.metrics.find(m => m.id === 'acos')!
const cost = s.metrics.find(m => m.id === 'cost')!, sales = s.metrics.find(m => m.id === 'sales')!
console.log(`   acos.current  = ${acos.current?.toFixed(6)}   vs  cost/sales = ${(cost.current!/sales.current!).toFixed(6)}`)
console.log(`   acos.previous = ${acos.previous?.toFixed(6)}   vs  cost/sales = ${(cost.previous!/sales.previous!).toFixed(6)}`)

console.log('\n4. SERIES (first 4 buckets)')
for (const p of s.series.slice(0,4)) console.log('   ', JSON.stringify(p))

console.log('\n5. A REPORT WITH NO TIMELINE SAYS SO')
const ci = await reportSummary({ reportId: 'console-import', from: '2026-03-03', to: '2026-08-03', compare: 'none' })
console.log('   timeSeries:', ci.timeSeries, '· series:', ci.series.length, '· reason:', ci.noSeriesReason)

console.log('\n6. YOY WITH NO BASELINE YIELDS null, NOT INFINITY')
const y = await reportSummary({ reportId: 'campaign', from: '2026-07-05', to: '2026-08-03', compare: 'yoy' })
console.log('   ', y.metrics.map(m => `${m.id}:${m.deltaPct === null ? 'null' : m.deltaPct.toFixed(2)}`).join(' '))
process.exit(0)
