import { resolve } from 'path'
import { config } from 'dotenv'
config(); config({ path: resolve(new URL('.', import.meta.url).pathname, '../../../.env') })
const s = await import('../src/services/advertising/ads-saved-reports.service.js')
const { runReport } = await import('../src/services/advertising/ads-report-runner.service.js')

const created = await s.createSavedReport({
  name: 'IT · high-ACOS search terms',
  description: 'Weekly negation candidates',
  query: { reportId: 'search-term', from: '2026-07-06', to: '2026-08-04', marketplaces: ['IT'], groupBy: ['query'], sort: { col: 'cost', dir: 'desc' } } as never,
})
console.log('1. created      ->', created.id, `v${created.version}`)

const edited = await s.updateSavedReport(created.id, {
  query: { ...created.query, from: '2026-01-01', marketplaces: ['IT', 'DE'], columns: ['query', 'cost', 'acos', 'cpc'] } as never,
})
console.log('2. edited       -> v' + edited.version)

const renamed = await s.updateSavedReport(created.id, { name: 'EU · high-ACOS search terms' })
console.log('3. renamed      -> v' + renamed.version)

console.log('\n4. VERSION HISTORY (newest first):')
for (const v of await s.listVersions(created.id)) {
  console.log(`   v${v.version}${v.isCurrent ? ' *current*' : '        '}  ${v.changeNote}`)
}

const restored = await s.restoreVersion(created.id, 1)
console.log(`\n5. restored v1  -> now v${restored.version}, name="${restored.name}", from=${restored.query.from}, markets=${restored.query.marketplaces}`)
console.log('   history is append-only:', (await s.listVersions(created.id)).length, 'versions, v1 still present:',
  (await s.listVersions(created.id)).some(v => v.version === 1))

const run = await runReport(s.toReportQuery(restored.query, 1, 5))
console.log(`\n6. runs directly-> ${run.total} groups, ${run.elapsedMs}ms, cols: ${run.columns.map(c=>c.id).join(',')}`)

console.log('\n7. guards:')
try { await s.updateSavedReport(created.id, { query: { ...restored.query, reportId: 'campaign' } as never }) }
catch (e) { console.log('   repoint to another report ->', (e as Error).message) }
try { await s.createSavedReport({ name: 'x', query: { reportId: 'no-such-report' } as never }) }
catch (e) { console.log('   unknown report id        ->', (e as Error).message) }
try { await s.createSavedReport({ name: '  ', query: { reportId: 'campaign' } as never }) }
catch (e) { console.log('   blank name               ->', (e as Error).message) }

await s.archiveSavedReport(created.id)
console.log('\n8. archived     -> listed:', (await s.listSavedReports()).some(r => r.id === created.id))
process.exit(0)
