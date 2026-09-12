/** ADM.16 — create-test the REAL TARGETING_COLUMNS set so an invalid name can't break the
 *  nightly targeting ingest. Acceptance = a reportId comes back. */
import prisma from '../src/db.js'
import { liveCall } from '../src/services/advertising/ads-api-client.js'
import { TARGETING_COLUMNS, TARGETING_REPORT_TYPE_ID } from '../src/services/advertising/ads-reports.service.js'
const conn = await prisma.amazonAdsConnection.findFirst({ where: { marketplace: 'IT' }, select: { profileId: true, region: true } })
const ctx = { profileId: conn!.profileId, region: conn!.region as 'EU' }
try {
  const r = await liveCall<{ reportId: string }>({ ...ctx, method: 'POST', path: '/reporting/reports', body: {
    name: 'nexus-tgt-combo', startDate: '2026-08-24', endDate: '2026-08-24',
    configuration: { adProduct: 'SPONSORED_PRODUCTS', groupBy: ['targeting'], columns: TARGETING_COLUMNS, reportTypeId: TARGETING_REPORT_TYPE_ID, timeUnit: 'DAILY', format: 'GZIP_JSON' } } })
  console.log(`spTargeting ACCEPTED (${TARGETING_COLUMNS.length} cols) reportId=${r.reportId}`)
} catch (e) { console.log('🔴 REJECTED:', (e as Error).message.slice(0, 350).replace(/\s+/g,' ')) }
await prisma.$disconnect()
