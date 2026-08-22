/**
 * SPC.0 — the two ceilings that size the backfill. READ-ONLY.
 *
 * Deliberately sends dates Amazon MUST reject, so validation fails and no report
 * job is created. If a probe unexpectedly succeeds it is reported loudly.
 */
import { resolve } from 'path'; import { config } from 'dotenv'
config(); config({ path: resolve('/Users/awais/nexus-commerce/.env') })
const { PrismaClient } = await import('@prisma/client')
const prisma = new PrismaClient({ log: [] })
const { liveCall } = await import('../src/services/advertising/ads-api-client.js')

const conn = await prisma.amazonAdsConnection.findFirst({
  where: { marketplace: 'IT', isActive: true }, select: { profileId: true, region: true },
})
if (!conn) { console.log('no IT connection'); process.exit(1) }
const ctx = { profileId: conn.profileId, region: (conn.region as 'EU') ?? 'EU' }

const COLS = ['date','campaignId','campaignName','campaignStatus','impressions','clicks','cost',
  'sales7d','purchases7d','unitsSoldClicks7d']

const iso = (d: Date) => d.toISOString().slice(0,10)
const daysAgo = (n: number) => { const d = new Date(); d.setUTCDate(d.getUTCDate()-n); return iso(d) }

async function probe(label: string, startDate: string, endDate: string) {
  try {
    const r = await liveCall<{ reportId?: string }>({
      ...ctx, method: 'POST', path: '/reporting/reports',
      body: { name: `spc0-${label}`, startDate, endDate,
        configuration: { adProduct: 'SPONSORED_PRODUCTS', groupBy: ['campaign'], columns: COLS,
          reportTypeId: 'spCampaigns', timeUnit: 'DAILY', format: 'GZIP_JSON' } },
    })
    console.log(`${label.padEnd(30)} ${startDate}→${endDate}  ⚠ ACCEPTED (reportId ${r.reportId}) — a job WAS created`)
  } catch (e) {
    const err = e as Error & { statusCode?: number; body?: string }
    const body = (err.body ?? err.message).replace(/\s+/g,' ').slice(0, 230)
    console.log(`${label.padEnd(30)} ${startDate}→${endDate}  ${err.statusCode}  ${body}`)
  }
}

console.log('— lookback ceiling —')
await probe('year 2000', '2000-01-01', '2000-01-02')
await probe('400 days ago, 1 day', daysAgo(400), daysAgo(400))
await probe('200 days ago, 1 day', daysAgo(200), daysAgo(200))
await probe('120 days ago, 1 day', daysAgo(120), daysAgo(120))

console.log('\n— max range (all ending yesterday) —')
await probe('400-day range', daysAgo(400), daysAgo(1))
await probe('180-day range', daysAgo(180), daysAgo(1))
await probe('95-day range', daysAgo(95), daysAgo(1))
await prisma.$disconnect()
