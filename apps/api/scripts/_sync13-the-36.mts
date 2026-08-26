/** SYNC.13 — the 36 campaigns Amazon held PAUSED on 2026-08-21 19:20.
 *  Which are enabled today, and does rank-schedule membership explain the split exactly? */
import prisma from '../src/db.js'

const drift = await prisma.adDrift.findMany({
  where: { entityType: 'CAMPAIGN', field: 'status', firstDetectedAt: { gte: new Date('2026-08-21T19:00:00Z'), lte: new Date('2026-08-21T20:00:00Z') } },
  select: { entityId: true, entityName: true, ourValue: true, amazonValue: true },
})
const camps = await prisma.campaign.findMany({
  where: { id: { in: drift.map((d) => d.entityId) } },
  select: { id: true, name: true, status: true, marketplace: true },
})
const byId = new Map(camps.map((c) => [c.id, c]))
const scheduled = new Set((await prisma.adSchedule.findMany({ where: { enabled: true }, select: { campaignId: true } })).map((s) => s.campaignId))

// Which of them did rank-defend actually re-enable at 19:30?
const reEnabled = new Set((await prisma.advertisingActionLog.findMany({
  where: { actionType: 'AD_ENTITY_STATE_UPDATE', entityType: 'CAMPAIGN', createdAt: { gte: new Date('2026-08-21T19:25:00Z'), lte: new Date('2026-08-21T19:40:00Z') } },
  select: { entityId: true },
})).map((r) => r.entityId))

let reEnabledNowEnabled = 0, untouchedNowPaused = 0, anomalies: string[] = []
console.log('campaign                                    | you paused on AMZ | rank-sched | re-enabled 19:30 | status TODAY')
console.log('-'.repeat(112))
for (const d of drift.sort((a, b) => String(byId.get(a.entityId)?.name).localeCompare(String(byId.get(b.entityId)?.name)))) {
  const c = byId.get(d.entityId)
  if (!c) continue
  const sch = scheduled.has(c.id), re = reEnabled.has(c.id)
  console.log(`${String(c.name).slice(0,43).padEnd(43)} | ${String(d.amazonValue).padEnd(17)} | ${(sch?'YES':'no').padEnd(10)} | ${(re?'YES':'no').padEnd(16)} | ${c.status}`)
  if (re && c.status === 'ENABLED') reEnabledNowEnabled++
  if (!re && c.status === 'PAUSED') untouchedNowPaused++
  if (re && c.status !== 'ENABLED') anomalies.push(`${c.name}: re-enabled but now ${c.status}`)
  if (!re && c.status === 'ENABLED') anomalies.push(`${c.name}: NOT re-enabled by the engine, yet ENABLED today`)
}
console.log('-'.repeat(112))
console.log(`\ntotal campaigns you paused on Amazon that night : ${drift.length}`)
console.log(`  re-enabled by rank-defend  -> ENABLED today   : ${reEnabledNowEnabled}`)
console.log(`  left alone                 -> still PAUSED    : ${untouchedNowPaused}`)
if (anomalies.length) { console.log('\n  UNEXPLAINED:'); anomalies.forEach((a) => console.log('   ! ' + a)) }
else console.log('\n  -> rank-schedule membership explains the split with no exceptions.')
await prisma.$disconnect()
