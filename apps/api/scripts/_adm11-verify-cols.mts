/** ADM.11 — validate every column I intend to add against Amazon's own allowed list, per ad
 *  product. An invalid name 400s the WHOLE report, so this runs before any code change. */
import prisma from '../src/db.js'
import { liveCall } from '../src/services/advertising/ads-api-client.js'

const WANT: Record<string, string[]> = {
  SPONSORED_PRODUCTS: ['kindleEditionNormalizedPagesRead14d', 'kindleEditionNormalizedPagesRoyalties14d'],
  SPONSORED_BRANDS: ['newToBrandPurchases', 'newToBrandSales', 'newToBrandUnitsSold', 'newToBrandPurchasesRate', 'detailPageViews', 'viewClickThroughRate'],
  SPONSORED_DISPLAY: ['newToBrandPurchases', 'newToBrandSales', 'newToBrandUnitsSold', 'viewabilityRate', 'detailPageViews'],
}
const RTID: Record<string, string> = { SPONSORED_PRODUCTS: 'spCampaigns', SPONSORED_BRANDS: 'sbCampaigns', SPONSORED_DISPLAY: 'sdCampaigns' }

const conn = await prisma.amazonAdsConnection.findFirst({ where: { marketplace: 'IT' }, select: { profileId: true, region: true } })
const ctx = { profileId: conn!.profileId, region: conn!.region as 'EU' }

for (const [adProduct, want] of Object.entries(WANT)) {
  let allowed: string[] = []
  try {
    await liveCall({ ...ctx, method: 'POST', path: '/reporting/reports', body: {
      name: `nexus-verify-${adProduct}`, startDate: '2026-08-20', endDate: '2026-08-21',
      configuration: { adProduct, groupBy: ['campaign'], columns: ['date', '__probe__'], reportTypeId: RTID[adProduct], timeUnit: 'DAILY', format: 'GZIP_JSON' } } })
  } catch (e) {
    const m = /Allowed values: \(([^)]*)\)/.exec((e as Error).message)
    allowed = m ? m[1].split(',').map((s) => s.trim()) : []
  }
  const set = new Set(allowed)
  console.log(`\n=== ${adProduct} (${allowed.length} allowed) ===`)
  for (const c of want) console.log(`  ${set.has(c) ? 'OK     ' : 'REJECT '} ${c}`)
  const missing = want.filter((c) => !set.has(c))
  console.log(`  -> ${missing.length ? 'DO NOT ADD: ' + missing.join(', ') : 'all requested columns are valid'}`)
}
await prisma.$disconnect()
