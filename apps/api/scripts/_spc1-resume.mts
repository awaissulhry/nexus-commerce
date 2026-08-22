/** SPC.1 — poll + ingest the job already created for 2026-08-18 IT. */
import { resolve } from 'path'; import { config } from 'dotenv'
config(); config({ path: resolve('/Users/awais/nexus-commerce/.env') })
const { PrismaClient } = await import('@prisma/client')
const prisma = new PrismaClient({ log: [] })
const svc = await import('../src/services/advertising/ads-reports.service.js')
const DAY = '2026-08-18'

const job = await prisma.amazonAdsReportJob.findFirst({
  where: { reportTypeId: 'spCampaigns', startDate: new Date(DAY), endDate: new Date(DAY) },
  orderBy: { createdAt: 'desc' },
  select: { id: true, status: true, location: true, profileId: true, fileSize: true, ingestedAt: true },
})
if (!job) { console.log('NO JOB FOUND'); process.exit(1) }
console.log('job', job.id, job.status, 'file', job.fileSize, 'ingestedAt', job.ingestedAt)

for (let i = 0; i < 60 && job.status !== 'COMPLETED'; i++) {
  await svc.pollPendingJobs()
  const r = await prisma.amazonAdsReportJob.findUnique({ where: { id: job.id }, select: { status: true, location: true, fileSize: true } })
  console.log(`  poll ${i}: ${r?.status} ${r?.fileSize ?? ''}`)
  if (r?.status === 'COMPLETED' && r.location) { job.status = 'COMPLETED'; break }
  if (r?.status === 'FAILED') { console.log('FAILED'); process.exit(1) }
  await new Promise(r2 => setTimeout(r2, 20_000))
}
console.log('ingest:', JSON.stringify(await svc.ingestCompletedJob(job.id)))

const s = await prisma.amazonAdsDailyPerformance.findFirst({
  where: { entityType: 'CAMPAIGN', marketplace: 'IT', date: new Date(DAY), sales7dCents: { gt: 0 } },
  orderBy: { costMicros: 'desc' },
}) as Record<string, unknown> | null
if (s) {
  const g = (k: string) => `${k}=${s[k] ?? 'NULL'}`
  console.log('\nsample —', s.entityName, '·', s.entityStatus)
  console.log(' sales  :', ['sales1dCents','sales7dCents','sales14dCents','sales30dCents'].map(g).join(' '))
  console.log(' orders :', ['orders1d','orders7d','orders14d','orders30d'].map(g).join(' '))
  console.log(' sameSku:', ['salesSameSku1dCents','salesSameSku7dCents','salesSameSku30dCents','ordersSameSku7d','unitsSameSku7d'].map(g).join(' '))
  console.log(' share  :', g('topOfSearchIS'))
  console.log(' setting:', ['campaignBudgetCents','campaignBudgetType','campaignBiddingStrategy','campaignBudgetRuleName'].map(g).join(' '))
}
console.log('\ncoverage:', JSON.stringify((await prisma.$queryRawUnsafe(`
  SELECT COUNT(*)::int rows, COUNT("entityName")::int named, COUNT("salesSameSku7dCents")::int samesku,
         COUNT("topOfSearchIS")::int tos, COUNT("campaignBudgetCents")::int budget, COUNT("sales1dCents")::int s1d,
         COUNT("sales14dCents")::int s14d
  FROM "AmazonAdsDailyPerformance" WHERE "entityType"='CAMPAIGN' AND "marketplace"='IT' AND "date"=DATE '${DAY}'`) as unknown[])[0]))
await prisma.$disconnect()
