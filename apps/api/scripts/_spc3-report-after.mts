import { resolve } from 'path'; import { config } from 'dotenv'
config(); config({ path: resolve('/Users/awais/nexus-commerce/.env') })
const { runReport } = await import('../src/services/advertising/ads-report-runner.service.js')
const r = await runReport({ reportId: 'campaign', from: '2026-05-21', to: '2026-07-27',
  marketplaces: ['IT'], groupBy: ['marketplace'], columns: ['impressions','clicks','cost','sales','acos'], page: 1, pageSize: 5 })
console.log('campaign report totals now:', JSON.stringify(r.totals))
