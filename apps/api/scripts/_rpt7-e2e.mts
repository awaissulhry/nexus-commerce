import { resolve } from 'path'
import { readFileSync } from 'fs'
import { config } from 'dotenv'
config(); config({ path: resolve(new URL('.', import.meta.url).pathname, '../../../.env') })
const svc = await import('../src/services/advertising/ads-console-import.service.js')
const { runReport } = await import('../src/services/advertising/ads-report-runner.service.js')
const eur = (c: number) => '€' + (c / 100).toLocaleString('en-GB', { minimumFractionDigits: 2 })
const FILE = '/Users/awais/Downloads/Campaign_-_07_29_2026T04_39_35.csv'
const text = readFileSync(FILE, 'utf8')

console.log('1. PREVIEW (nothing visible to any report yet)')
let t = Date.now()
const pv = await svc.previewImport('Campaign_-_07_29_2026T04_39_35.csv', text.length, text)
console.log(`   ${Date.now() - t}ms · import ${pv.importId} · status ${pv.status}`)
console.log(`   read ${pv.rowsRead.toLocaleString('en-GB')} · merged ${pv.rowsMerged} · new ${pv.rowsNew.toLocaleString('en-GB')} · unchanged ${pv.rowsUnchanged} · conflicting ${pv.rowsConflicting} · skipped ${pv.rowsSkipped} · errors ${pv.rowsErrored}`)
console.log(`   window ${pv.windowStart} → ${pv.windowEnd} · ${eur(pv.totals.costCents)} spend · ${eur(pv.totals.salesCents)} sales`)

console.log('\n2. RUNNER sees nothing while it is only a preview')
let r = await runReport({ reportId: 'console-import', page: 1, pageSize: 3 })
console.log(`   rows visible: ${r.total}`)

console.log('\n3. COMMIT')
t = Date.now()
const c = await svc.commitImport(pv.importId)
console.log(`   ${Date.now() - t}ms · committed ${c.rows.toLocaleString('en-GB')} rows`)

console.log('\n4. RUNNER now serves it — same engine, export and scheduling as every other report')
r = await runReport({ reportId: 'console-import', page: 1, pageSize: 5 })
console.log(`   ${r.total.toLocaleString('en-GB')} groups · ${r.elapsedMs}ms · grouped by ${r.applied.groupBy.join('+')}`)
console.log('   ' + r.columns.map(x => x.label).join(' | '))
for (const row of r.rows) console.log('   ' + r.columns.map(x => String(row[x.id] ?? '—')).join(' | '))
console.log('   TOTALS: ' + r.columns.filter(x=>x.kind==='metric').map(x=>`${x.id}=${r.totals?.[x.id]}`).join(' '))

console.log('\n5. RE-IMPORTING THE SAME FILE IS VISIBLY A NO-OP')
const pv2 = await svc.previewImport('same-file-again.csv', text.length, text)
console.log(`   new ${pv2.rowsNew} · unchanged ${pv2.rowsUnchanged.toLocaleString('en-GB')} · conflicting ${pv2.rowsConflicting}`)
await svc.discardImport(pv2.importId)
console.log('   preview discarded')

console.log('\n6. HISTORY WE DID NOT HAVE BEFORE')
const early = await runReport({ reportId: 'console-import', from: '2026-03-03', to: '2026-05-19', groupBy: ['searchTerm'], page: 1, pageSize: 3 })
console.log(`   ${early.total.toLocaleString('en-GB')} search terms between 2026-03-03 and 2026-05-19 — before our own ingest begins (2026-05-20)`)
process.exit(0)
