/** Poll + ingest the backfill jobs using the NEW selection (no take cap). */
import prisma from '../src/db.js'
import { pollPendingJobs, ingestCompletedJob } from '../src/services/advertising/ads-reports.service.js'

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
for (let round = 1; round <= 12; round++) {
  const poll = await pollPendingJobs(40)
  const jobs = await prisma.amazonAdsReportJob.findMany({
    where: { status: 'COMPLETED', location: { not: null }, ingestedAt: null,
             completedAt: { gt: new Date(Date.now() - 50 * 60 * 1000) } },
    select: { id: true }, orderBy: { completedAt: 'asc' },
  })
  let rows = 0
  for (const j of jobs) {
    try { rows += (await ingestCompletedJob(j.id)).rowsIngested }
    catch (e) { console.log('  ingest error', j.id, String(e).slice(0, 80)) }
  }
  const left = await prisma.amazonAdsReportJob.count({ where: { status: { in: ['PENDING', 'IN_PROGRESS'] } } })
  console.log(`round ${round}: polled=${JSON.stringify(poll)} ingested=${jobs.length} rows=${rows} stillPending=${left}`)
  if (left === 0 && jobs.length === 0) break
  await sleep(20_000)
}
await prisma.$disconnect()
process.exit(0)
