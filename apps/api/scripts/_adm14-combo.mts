/** ADM.14 — create ONE tiny report per ad product using the REAL CAMPAIGN_COLUMNS set, to prove
 *  the new columns are accepted in combination (not just individually valid). 1-day window so the
 *  serial report queue is barely touched. Acceptance = a reportId comes back. */
import prisma from '../src/db.js'
import { liveCall } from '../src/services/advertising/ads-api-client.js'
import { CAMPAIGN_COLUMNS, CAMPAIGN_REPORT_TYPE_ID } from '../src/services/advertising/ads-reports.service.js'

const conn = await prisma.amazonAdsConnection.findFirst({ where: { marketplace: 'IT' }, select: { profileId: true, region: true } })
const ctx = { profileId: conn!.profileId, region: conn!.region as 'EU' }

for (const adProduct of ['SPONSORED_PRODUCTS', 'SPONSORED_BRANDS', 'SPONSORED_DISPLAY'] as const) {
  const columns = CAMPAIGN_COLUMNS[adProduct]
  try {
    const r = await liveCall<{ reportId: string }>({ ...ctx, method: 'POST', path: '/reporting/reports', body: {
      name: `nexus-combo-${adProduct}`, startDate: '2026-08-24', endDate: '2026-08-24',
      configuration: { adProduct, groupBy: ['campaign'], columns, reportTypeId: CAMPAIGN_REPORT_TYPE_ID[adProduct], timeUnit: 'DAILY', format: 'GZIP_JSON' } } })
    console.log(`${adProduct.padEnd(20)} ACCEPTED (${columns.length} cols) reportId=${r.reportId}`)
  } catch (e) {
    const m = (e as Error).message
    console.log(`${adProduct.padEnd(20)} 🔴 REJECTED (${columns.length} cols)`)
    console.log(`   ${m.slice(0, 400).replace(/\s+/g, ' ')}`)
  }
}
await prisma.$disconnect()
