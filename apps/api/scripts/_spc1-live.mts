/**
 * SPC.1 — end to end on ONE day, ONE market. Creates one real report job and
 * ingests it; the upsert lands on rows that already exist, filling the new columns.
 */
import { resolve } from 'path'; import { config } from 'dotenv'
config(); config({ path: resolve('/Users/awais/nexus-commerce/.env') })
const { PrismaClient } = await import('@prisma/client')
const prisma = new PrismaClient({ log: [] })
const svc = await import('../src/services/advertising/ads-reports.service.js')

const DAY = '2026-08-18'
const conn = await prisma.amazonAdsConnection.findFirst({
  where: { marketplace: 'IT', isActive: true }, select: { profileId: true, region: true },
})
if (!conn) { console.log('no IT connection'); process.exit(1) }

console.log(`requesting spCampaigns · IT · ${DAY} · ${svc.CAMPAIGN_COLUMNS.SPONSORED_PRODUCTS.length} columns`)
const job = await svc.createReportJob({
  profileId: conn.profileId, region: (conn.region as 'EU') ?? 'EU', marketplace: 'IT',
  currencyCode: 'EUR', adProduct: 'SPONSORED_PRODUCTS',
  reportTypeId: svc.CAMPAIGN_REPORT_TYPE_ID.SPONSORED_PRODUCTS,
  startDate: DAY, endDate: DAY, groupBy: ['campaign'],
  columns: svc.CAMPAIGN_COLUMNS.SPONSORED_PRODUCTS, timeUnit: 'DAILY',
})
console.log('job', job.jobId, job.status, job.alreadyExisted ? '(reused)' : '')

for (let i = 0; i < 40; i++) {
  await new Promise(r => setTimeout(r, 15_000))
  await svc.pollPendingJobs()
  const row = await prisma.amazonAdsReportJob.findUnique({
    where: { id: job.jobId }, select: { status: true, location: true, fileSize: true, errorMessage: true },
  })
  process.stdout.write(`  ${i * 15 + 15}s ${row?.status}${row?.fileSize ? ` ${row.fileSize}B` : ''}\n`)
  if (row?.status === 'COMPLETED' && row.location) break
  if (row?.status === 'FAILED') { console.log('FAILED', row.errorMessage); process.exit(1) }
}

const res = await svc.ingestCompletedJob(job.jobId)
console.log('ingest:', JSON.stringify(res))

const sample = await prisma.amazonAdsDailyPerformance.findFirst({
  where: { entityType: 'CAMPAIGN', marketplace: 'IT', date: new Date(DAY), sales7dCents: { gt: 0 } },
  orderBy: { costMicros: 'desc' },
})
if (!sample) { console.log('no sample row with sales'); process.exit(0) }
const show = (k: string) => `${k}=${(sample as Record<string, unknown>)[k] ?? 'NULL'}`
console.log('\nsample row —', sample.entityName ?? '(no name)', '·', sample.entityStatus ?? '(no status)')
console.log(' windows :', ['sales1dCents','sales7dCents','sales14dCents','sales30dCents'].map(show).join(' '))
console.log(' orders  :', ['orders1d','orders7d','orders14d','orders30d'].map(show).join(' '))
console.log(' units   :', ['units1d','units7d','units14d','units30d'].map(show).join(' '))
console.log(' sameSku :', ['salesSameSku1dCents','salesSameSku7dCents','salesSameSku14dCents','salesSameSku30dCents'].map(show).join(' '))
console.log(' sameSkuO:', ['ordersSameSku7d','unitsSameSku7d'].map(show).join(' '))
console.log(' share   :', show('topOfSearchIS'))
console.log(' settings:', ['campaignBudgetCents','campaignBudgetType','campaignBiddingStrategy'].map(show).join(' '))
console.log(' budrule :', ['campaignRuleBasedBudgetCents','campaignBudgetRuleId','campaignBudgetRuleName'].map(show).join(' '))

const filled = await prisma.$queryRawUnsafe<Array<Record<string, unknown>>>(`
  SELECT COUNT(*)::int rows,
         COUNT("entityName")::int named,
         COUNT("salesSameSku7dCents")::int samesku,
         COUNT("topOfSearchIS")::int tos,
         COUNT("campaignBudgetCents")::int budget,
         COUNT("sales1dCents")::int s1d
  FROM "AmazonAdsDailyPerformance"
  WHERE "entityType"='CAMPAIGN' AND "marketplace"='IT' AND "date"=DATE '${DAY}'`)
console.log('\ncoverage on that day:', JSON.stringify(filled[0]))
await prisma.$disconnect()
