import prisma from '../src/db.js'
import { pollPendingJobs, ingestCompletedJob } from '../src/services/advertising/ads-reports.service.js'
await pollPendingJobs(40)
const jobs = await prisma.amazonAdsReportJob.findMany({
  where: { status: 'COMPLETED', location: { not: null }, ingestedAt: null },
  select: { id: true, completedAt: true }, orderBy: { completedAt: 'asc' },
})
console.log('un-ingested COMPLETED jobs:', jobs.length)
let rows = 0, errs = 0
for (const j of jobs) {
  try { rows += (await ingestCompletedJob(j.id)).rowsIngested }
  catch (e) { errs++; console.log('  err', String(e).slice(0, 100)) }
}
console.log(`ingested=${jobs.length} rows=${rows} errors=${errs}`)
await prisma.$disconnect(); process.exit(0)
