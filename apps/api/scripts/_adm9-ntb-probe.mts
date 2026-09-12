/** ADM.9 — ask Amazon which columns each ad product's campaign report actually allows.
 *  A rejected column name makes v3 return its "allowed values" list. Validation happens at
 *  CREATE, so an invalid request creates NO report — this is read-only and costs no quota slot. */
import prisma from '../src/db.js'
import { liveCall } from '../src/services/advertising/ads-api-client.js'

const conn = await prisma.amazonAdsConnection.findFirst({ where: { marketplace: 'IT' }, select: { profileId: true, region: true } })
if (!conn) { console.log('no IT connection'); process.exit(0) }
const ctx = { profileId: conn.profileId, region: (conn.region as 'EU') }

for (const adProduct of ['SPONSORED_PRODUCTS']) {
  try {
    await liveCall<{ reportId: string }>({
      ...ctx, method: 'POST', path: '/reporting/reports',
      body: {
        name: `nexus-colprobe-${adProduct}`,
        startDate: '2026-08-20', endDate: '2026-08-21',
        configuration: {
          adProduct, groupBy: ['campaign'], columns: ['date', 'campaignId', '__nexus_invalid_column__'],
          reportTypeId: adProduct === 'SPONSORED_PRODUCTS' ? 'spCampaigns' : adProduct === 'SPONSORED_BRANDS' ? 'sbCampaigns' : 'sdCampaigns',
          timeUnit: 'DAILY', format: 'GZIP_JSON',
        },
      },
    })
    console.log(`${adProduct}: unexpectedly ACCEPTED an invalid column`)
  } catch (e) {
    const msg = (e as Error).message
    const ntb = [...msg.matchAll(/newToBrand[A-Za-z0-9]*/g)].map((m) => m[0])
    const view = [...msg.matchAll(/view[A-Za-z0-9]*/gi)].map((m) => m[0])
    const dpv = [...msg.matchAll(/detailPage[A-Za-z0-9]*/g)].map((m) => m[0])
    console.log(`\n=== ${adProduct} ===`)
    console.log(`  newToBrand* allowed (${new Set(ntb).size}): ${[...new Set(ntb)].join(', ') || 'NONE'}`)
    console.log(`  view* allowed        : ${[...new Set(view)].join(', ') || 'NONE'}`)
    console.log(`  detailPage* allowed  : ${[...new Set(dpv)].join(', ') || 'NONE'}`)
    console.log(`  RAW: ${msg.slice(0, 6000).replace(/\s+/g, ' ')}`)
  }
}
await prisma.$disconnect()
