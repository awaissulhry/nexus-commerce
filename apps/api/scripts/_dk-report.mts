import { runReport } from '../src/services/advertising/ads-report-runner.service.js'
const r = await runReport({ reportId: 'economics', from: '2026-07-19', to: '2026-07-25', page: 1, pageSize: 5 })
console.log('rows:', r.rows.length, '| total:', r.total, '| ms:', r.elapsedMs)
console.log('markets seen:', JSON.stringify(r.totals ? Object.keys(r.totals) : []))
console.table(r.rows)
console.log('TOTALS:', JSON.stringify(r.totals))
process.exit(0)
