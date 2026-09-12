import '../src/env.js'
const { runReport } = await import('../src/services/advertising/ads-report-runner.service.js')
for (const id of ['brand-metrics', 'campaign']) {
  const r = await runReport({ reportId: id, from: '2026-07-28', to: '2026-08-26', marketplaces: [], adProducts: [], search: null, groupBy: [], columns: [], sort: null, page: 1, pageSize: 3 })
  console.log(`${id.padEnd(15)} rows=${r.total}  totals=${r.totals ? JSON.stringify(r.totals).slice(0,70) : 'null'}  reason=${r.noTotalsReason ? r.noTotalsReason.slice(0,54) + '…' : '—'}`)
}
const { default: prisma } = await import('../src/db.js'); await prisma.$disconnect()
