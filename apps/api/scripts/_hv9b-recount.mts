/** HV.9b — what did today actually create at Amazon? READ-ONLY. */
import '../src/env.js'
const { default: prisma } = await import('../src/db.js')
const rows = await prisma.$queryRaw<Array<{id:string;kw:string;ext:string;created:Date;camp:string}>>`
  WITH f AS (SELECT DISTINCT ON ("entityId") "entityId" FROM "AdvertisingActionLog"
             WHERE "actionType"='create_keyword' AND "userId"='automation:auto-harvest' ORDER BY "entityId","createdAt" ASC)
  SELECT t.id, t."expressionValue" AS kw, t."externalTargetId" AS ext, t."createdAt" AS created, c.name AS camp
  FROM "AdTarget" t JOIN f ON f."entityId"=t.id JOIN "AdGroup" g ON g.id=t."adGroupId" JOIN "Campaign" c ON c.id=g."campaignId"
  WHERE t."isNegative"=false AND t."externalTargetId" IS NOT NULL ORDER BY t."createdAt"`
console.log(`\n  harvested keywords now carrying an Amazon id: ${rows.length}`)
const pushed = await prisma.advertisingActionLog.findMany({ where:{ actionType:'push_keyword' }, select:{ entityId:true }, distinct:['entityId'] })
const pushedIds = new Set(pushed.map(p=>p.entityId))
for (const r of rows) console.log(`  ${r.created.toISOString().slice(0,10)} "${String(r.kw).slice(0,28).padEnd(30)}" ext=${r.ext} ${pushedIds.has(r.id)?'← PUSHED TODAY':''} ${String(r.camp).slice(0,24)}`)
console.log(`\n  of those, pushed today: ${rows.filter(r=>pushedIds.has(r.id)).length} · pre-existing: ${rows.filter(r=>!pushedIds.has(r.id)).length}`)
const localOnly = await prisma.$queryRaw<Array<{n:bigint}>>`
  WITH f AS (SELECT DISTINCT ON ("entityId") "entityId" FROM "AdvertisingActionLog"
             WHERE "actionType"='create_keyword' AND "userId"='automation:auto-harvest' ORDER BY "entityId","createdAt" ASC)
  SELECT COUNT(*)::bigint AS n FROM "AdTarget" t JOIN f ON f."entityId"=t.id
  WHERE t."isNegative"=false AND t."externalTargetId" IS NULL`
console.log(`  still local-only: ${Number(localOnly[0].n)}`)
await prisma.$disconnect()
