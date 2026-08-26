/** SYNC.12 — post-deploy: the engines still run, and no longer write campaign state. */
import prisma from '../src/db.js'

for (const job of ['ad-rank-defend', 'ad-dayparting', 'ads-campaign-settings-sync']) {
  const runs = await prisma.cronRun.findMany({ where: { jobName: job }, orderBy: { startedAt: 'desc' }, take: 3, select: { startedAt: true, status: true, outputSummary: true, errorMessage: true } })
  console.log(`-- ${job}`)
  for (const r of runs) console.log(`   ${r.startedAt.toISOString().slice(11,16)} ${String(r.status).padEnd(8)} ${r.outputSummary ?? ''} ${r.errorMessage ? '!! ' + r.errorMessage.slice(0,100) : ''}`)
}

const since = new Date(Date.now() - 60 * 60 * 1000)
const st = await prisma.advertisingActionLog.count({ where: { actionType: 'AD_ENTITY_STATE_UPDATE', entityType: 'CAMPAIGN', createdAt: { gte: since } } })
console.log(`\nCAMPAIGN state writes in the last hour: ${st}  (expected 0 from automation)`)

const last = await prisma.advertisingActionLog.findFirst({ where: { actionType: 'AD_ENTITY_STATE_UPDATE', entityType: 'CAMPAIGN' }, orderBy: { createdAt: 'desc' }, select: { createdAt: true, userId: true } })
console.log(`most recent CAMPAIGN state write ever: ${last?.createdAt.toISOString().slice(0,16)} by ${last?.userId}`)

const pop = await prisma.$queryRawUnsafe<any[]>(`SELECT status, COUNT(*)::int AS n FROM "Campaign" GROUP BY 1 ORDER BY 2 DESC`)
console.log('\ncampaign status now:', pop.map((p) => `${p.status}=${p.n}`).join('  '))
await prisma.$disconnect()
