/**
 * Coverage Ledger — enumerate the columns Amazon allows on spCampaigns. READ-ONLY.
 *
 * Method: POST /reporting/reports with ONE deliberately invalid column. Amazon
 * rejects with 400 and lists the allowed set in the failure body. No report is
 * created, nothing is stored, no quota-bearing job runs.
 *
 * Usage: cd apps/api && NEXUS_AMAZON_ADS_QUOTA_MODE=off railway run npx tsx scripts/_cl-spcampaigns-columns.mts
 */
import { resolve } from 'path'
import { config } from 'dotenv'
config(); config({ path: resolve('/Users/awais/nexus-commerce/.env') })

const { PrismaClient } = await import('@prisma/client')
const prisma = new PrismaClient()
const { liveCall } = await import('../src/services/advertising/ads-api-client.js')

const conn = await prisma.amazonAdsConnection.findFirst({
  where: { marketplace: 'IT', isActive: true }, select: { profileId: true, region: true },
})
if (!conn) { console.log('no IT connection'); process.exit(1) }
const ctx = { profileId: conn.profileId, region: (conn.region as 'EU') ?? 'EU' }
console.log('profile', conn.profileId)

async function enumerate(reportTypeId: string, adProduct: string, groupBy: string[]) {
  try {
    await liveCall({
      ...ctx, method: 'POST', path: '/reporting/reports',
      body: {
        name: `cl-probe-${reportTypeId}-${groupBy.join('_')}`,
        startDate: '2026-08-01', endDate: '2026-08-01',
        configuration: {
          adProduct, groupBy,
          columns: ['__nexus_invalid_column__'],
          reportTypeId, timeUnit: 'DAILY', format: 'GZIP_JSON',
        },
      },
    })
    console.log(`${reportTypeId} ${groupBy.join('+')}: UNEXPECTED SUCCESS — a report may have been created`)
  } catch (e) {
    const body = (e as Error & { body?: string }).body ?? (e as Error).message
    console.log(`\n════ ${reportTypeId} · groupBy=${JSON.stringify(groupBy)} · ${adProduct} ════`)
    console.log(body)
  }
}

await enumerate('spCampaigns', 'SPONSORED_PRODUCTS', ['campaign'])
await enumerate('spCampaigns', 'SPONSORED_PRODUCTS', ['campaignPlacement'])
await prisma.$disconnect()
