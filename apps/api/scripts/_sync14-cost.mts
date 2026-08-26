/** SYNC.14 — what did the 20 unintended re-enables spend since 2026-08-21 19:30? */
import prisma from '../src/db.js'

const ids = (await prisma.advertisingActionLog.findMany({
  where: { actionType: 'AD_ENTITY_STATE_UPDATE', entityType: 'CAMPAIGN', createdAt: { gte: new Date('2026-08-21T19:25:00Z'), lte: new Date('2026-08-21T19:40:00Z') } },
  select: { entityId: true },
})).map((r) => r.entityId)

const camps = await prisma.campaign.findMany({ where: { id: { in: ids } }, select: { id: true, name: true, externalCampaignId: true, marketplace: true } })
const ext = camps.map((c) => c.externalCampaignId!).filter(Boolean)

const rows = await prisma.$queryRawUnsafe<any[]>(`
  SELECT (SUM("costMicros")/1e6)::float AS spend, (SUM("sales7dCents")/100.0)::float AS sales,
         SUM(clicks)::int AS clicks, SUM(impressions)::bigint AS impr, MIN(date) AS d0, MAX(date) AS d1
  FROM "AmazonAdsDailyPerformance"
  WHERE "entityType"='CAMPAIGN' AND "entityId" = ANY($1::text[]) AND date >= '2026-08-22'`, ext)
const r = rows[0] ?? {}
console.log(`campaigns re-enabled against your intent : ${camps.length}`)
console.log(`window                                   : ${r.d0 ?? '-'} .. ${r.d1 ?? '-'}`)
console.log(`impressions                              : ${r.impr ?? 0}`)
console.log(`clicks                                   : ${r.clicks ?? 0}`)
console.log(`SPEND                                    : EUR ${(r.spend ?? 0).toFixed(2)}`)
console.log(`sales attributed                         : EUR ${(r.sales ?? 0).toFixed(2)}`)

console.log('\nper campaign:')
const per = await prisma.$queryRawUnsafe<any[]>(`
  SELECT "entityId" AS "campaignId", (SUM("costMicros")/1e6)::float AS spend, (SUM("sales7dCents")/100.0)::float AS sales
  FROM "AmazonAdsDailyPerformance" WHERE "entityType"='CAMPAIGN' AND "entityId" = ANY($1::text[]) AND date >= '2026-08-22'
  GROUP BY 1 ORDER BY 2 DESC NULLS LAST`, ext)
const nameByExt = new Map(camps.map((c) => [c.externalCampaignId!, c.name]))
for (const p of per) console.log(`  ${String(nameByExt.get(p.campaignId) ?? p.campaignId).slice(0,40).padEnd(40)} spend=EUR ${Number(p.spend ?? 0).toFixed(2).padStart(8)}  sales=EUR ${Number(p.sales ?? 0).toFixed(2).padStart(9)}`)
await prisma.$disconnect()
