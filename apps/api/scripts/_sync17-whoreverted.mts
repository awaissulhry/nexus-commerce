/** SYNC.17 — my re-pause set local PAUSED at 09:40. It reads ENABLED now. Who changed it? */
import prisma from '../src/db.js'
const since = new Date('2026-08-26T09:35:00Z')

console.log('=== AdvertisingActionLog since 09:35 (campaign-scoped) ===')
const logs = await prisma.advertisingActionLog.findMany({
  where: { createdAt: { gte: since }, entityType: 'CAMPAIGN' }, orderBy: { createdAt: 'asc' }, take: 60,
  select: { createdAt: true, actionType: true, payloadBefore: true, payloadAfter: true, userId: true, amazonResponseStatus: true },
})
for (const l of logs) {
  const b: any = l.payloadBefore, a: any = l.payloadAfter
  console.log(`  ${l.createdAt.toISOString().slice(11,19)} ${String(l.actionType).padEnd(22)} ${String(b?.name ?? '').slice(0,28).padEnd(28)} ${b?.status}->${a?.status} amz=${l.amazonResponseStatus ?? '-'} by=${l.userId ?? '-'}`)
}
if (!logs.length) console.log('  (none)')

console.log('\n=== CampaignBidHistory status rows since 09:35 ===')
const h = await prisma.$queryRawUnsafe<any[]>(`
  SELECT "changedAt", field, "oldValue", "newValue", actor, "entityId"
  FROM "CampaignBidHistory" WHERE "changedAt" >= $1 AND field='status' ORDER BY "changedAt" ASC LIMIT 60`, since)
for (const r of h) console.log(`  ${r.changedAt.toISOString().slice(11,19)} ${r.oldValue}->${r.newValue} actor=${r.actor}`)
if (!h.length) console.log('  (none)')

console.log('\n=== AdMutation rows for status (are they still pending? -> sync holds the field back) ===')
try {
  const m = await prisma.$queryRawUnsafe<any[]>(`
    SELECT field, status::text AS s, COUNT(*)::int AS n, MIN("createdAt") AS oldest, MAX("createdAt") AS newest
    FROM "AdMutation" WHERE "entityType"='CAMPAIGN' AND field='status' AND "createdAt" >= $1
    GROUP BY 1,2 ORDER BY 3 DESC`, since)
  if (!m.length) console.log('  (none)')
  for (const r of m) console.log(`  field=${r.field} status=${r.s} n=${r.n} oldest=${r.oldest?.toISOString?.().slice(11,19)} newest=${r.newest?.toISOString?.().slice(11,19)}`)
} catch (e) { console.log('  AdMutation:', (e as Error).message.slice(0,140)) }

console.log('\n=== settings-sync runs since 09:35 ===')
const runs = await prisma.cronRun.findMany({ where: { jobName: 'ads-campaign-settings-sync', startedAt: { gte: since } }, orderBy: { startedAt: 'asc' }, select: { startedAt: true, status: true, outputSummary: true } })
for (const r of runs) console.log(`  ${r.startedAt.toISOString().slice(11,19)} ${r.status} ${r.outputSummary}`)

console.log('\n=== Campaign.updatedAt / settingsSyncedAt for 3 of the 20 ===')
const c = await prisma.campaign.findMany({ where: { name: { in: ['GALE | IT | Auto', 'IT-AIRMESH-SP-Auto', 'GALE EXACT DE'] } }, select: { name: true, status: true, updatedAt: true, settingsSyncedAt: true } })
for (const x of c) console.log(`  ${String(x.name).padEnd(22)} ${x.status} updatedAt=${x.updatedAt.toISOString().slice(11,19)} settingsSyncedAt=${x.settingsSyncedAt?.toISOString().slice(11,19)}`)
await prisma.$disconnect()
