/** ADM.15 — what does the spTargeting report actually offer? Decides the honest wording for the
 *  Targets tab's dash columns, and whether same-SKU is a wireable gap at target grain. */
import prisma from '../src/db.js'
import { liveCall } from '../src/services/advertising/ads-api-client.js'
const conn = await prisma.amazonAdsConnection.findFirst({ where: { marketplace: 'IT' }, select: { profileId: true, region: true } })
const ctx = { profileId: conn!.profileId, region: conn!.region as 'EU' }
let allowed: string[] = []
try {
  await liveCall({ ...ctx, method: 'POST', path: '/reporting/reports', body: {
    name: 'nexus-tgt-probe', startDate: '2026-08-24', endDate: '2026-08-24',
    configuration: { adProduct: 'SPONSORED_PRODUCTS', groupBy: ['targeting'], columns: ['date', '__probe__'], reportTypeId: 'spTargeting', timeUnit: 'DAILY', format: 'GZIP_JSON' } } })
} catch (e) {
  const m = /Allowed values: \(([^)]*)\)/.exec((e as Error).message)
  allowed = m ? m[1].split(',').map((s) => s.trim()) : []
  if (!allowed.length) console.log('RAW:', (e as Error).message.slice(0, 300))
}
console.log(`spTargeting allows ${allowed.length} columns`)
for (const pat of ['newToBrand', 'view', 'kindle', 'SameSku', 'unitsSold', 'detailPage']) {
  const hit = allowed.filter((c) => c.toLowerCase().includes(pat.toLowerCase()))
  console.log(`  ${pat.padEnd(12)} -> ${hit.length ? hit.join(', ') : 'NONE'}`)
}
await prisma.$disconnect()
