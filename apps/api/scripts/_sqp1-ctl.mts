/** _sqp1-ctl.mts — SQP.1: was the +2 AmazonReportRun movement mine? READ-ONLY. */
import '../src/env.js'
import prisma from '../src/db.js'
async function main() {
  const rows = await prisma.amazonReportRun.findMany({
    where: { requestedAt: { gte: new Date(Date.now() - 3 * 3600 * 1000) } },
    select: { reportType: true, requestedAt: true, status: true, triggeredBy: true },
    orderBy: { requestedAt: 'desc' }, take: 15,
  })
  console.log('AmazonReportRun rows created in the last 3h:', rows.length)
  for (const r of rows) console.log(' ', r.requestedAt.toISOString().slice(11, 19), r.status, r.triggeredBy, r.reportType)
  console.log('of those, BRAND_ANALYTICS:', rows.filter((r) => r.reportType.includes('BRAND_ANALYTICS')).length)
}
main().then(() => prisma.$disconnect()).catch(async (e) => { console.error(e); await prisma.$disconnect(); process.exit(1) })
