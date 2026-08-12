/** _sqp2-smoke.mts — SQP.2: is the new table live on prod, and is the async path wired? READ-ONLY. */
import '../src/env.js'
import prisma from '../src/db.js'
async function main() {
  const n = await prisma.sqpReportRequest.count()
  console.log(`SqpReportRequest table reachable · rows = ${n}`)
  const g = await prisma.sqpReportRequest.groupBy({ by: ['status'], _count: { _all: true } })
  console.log('states:', g.map((x) => `${x.status}=${x._count._all}`).join(' · ') || '(none yet)')
  const cr = await prisma.cronRun.findMany({ where: { jobName: { in: ['sqp-ingest', 'sqp-collect'] } }, orderBy: { startedAt: 'desc' }, take: 4, select: { jobName: true, startedAt: true, status: true, outputSummary: true, errorMessage: true } })
  for (const r of cr) console.log(` ${r.startedAt.toISOString().slice(0, 16)} ${r.jobName} ${r.status} ${r.outputSummary ?? ''}${r.errorMessage ? ' ⚠ ' + r.errorMessage.slice(0, 80) : ''}`)
}
main().then(() => prisma.$disconnect()).catch(async (e) => { console.error(String(e).slice(0, 300)); await prisma.$disconnect(); process.exit(1) })
