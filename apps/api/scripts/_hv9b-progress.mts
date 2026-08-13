/** HV.9b — how many of the backlog have landed so far? READ-ONLY. */
import '../src/env.js'
const { default: prisma } = await import('../src/db.js')
const r = await prisma.$queryRaw<Array<{total:bigint;landed:bigint;local:bigint}>>`
  WITH f AS (SELECT DISTINCT ON ("entityId") "entityId" FROM "AdvertisingActionLog"
             WHERE "actionType"='create_keyword' AND "userId"='automation:auto-harvest' ORDER BY "entityId","createdAt" ASC)
  SELECT COUNT(*)::bigint AS total,
         COUNT(*) FILTER (WHERE t."externalTargetId" IS NOT NULL)::bigint AS landed,
         COUNT(*) FILTER (WHERE t."externalTargetId" IS NULL)::bigint AS local
  FROM "AdTarget" t JOIN f ON f."entityId"=t.id WHERE t."isNegative"=false`
console.log(`\n  engine-harvested keywords: ${Number(r[0].total)} · at Amazon: ${Number(r[0].landed)} · still local-only: ${Number(r[0].local)}`)
const pushes = await prisma.advertisingActionLog.count({ where:{ actionType:'push_keyword' } })
const recent = await prisma.advertisingActionLog.count({ where:{ actionType:'push_keyword', createdAt:{ gte: new Date(Date.now()-30*60_000) } } })
console.log(`  push_keyword audit rows: ${pushes} total · ${recent} in the last 30 min`)
const last = await prisma.advertisingActionLog.findMany({ where:{ actionType:'push_keyword' }, orderBy:{ createdAt:'desc' }, take:3, select:{ createdAt:true, payloadAfter:true } })
for (const l of last) console.log(`    ${l.createdAt.toISOString().slice(11,19)} ${JSON.stringify(l.payloadAfter).slice(0,120)}`)
await prisma.$disconnect()
