/** HV.9c.1 §3.7 — did the 54 pushes CREATE 6 keywords, or 3? READ-ONLY. */
import '../src/env.js'
const { default: prisma } = await import('../src/db.js')
const IDS=['252943870004724','126731108917969','156132292838069','16026030732543','169513143345169','204988683848148']
console.log('\n═══ for each pushed id: did a performance row exist BEFORE today? ═══')
console.log('   (a keyword Amazon only created today cannot have performance history)')
for (const ext of IDS) {
  const t = await prisma.adTarget.findFirst({ where:{ externalTargetId: ext }, select:{ id:true, expressionValue:true, adGroup:{ select:{ name:true } } } })
  const perf = await prisma.$queryRaw<Array<{n:bigint;first:Date|null;last:Date|null}>>`
    SELECT COUNT(*)::bigint AS n, MIN(date) AS first, MAX(date) AS last
    FROM "AmazonAdsDailyPerformance" WHERE "entityType"='AD_TARGET' AND "localEntityId"=${t?.id ?? ''}`
  const p = perf[0]
  // and: does ANOTHER local row exist with the same text+adgroup that USED to hold this id?
  console.log(`  ${ext}  "${String(t?.expressionValue).slice(0,28).padEnd(30)}" perfRows=${Number(p.n)} ${Number(p.n)>0?`(${p.first?.toISOString().slice(0,10)} → ${p.last?.toISOString().slice(0,10)}) 🔴 PRE-EXISTING`:'← genuinely NEW today'}`)
}
console.log('\n═══ HV.5 recorded 9 harvested keywords at Amazon on 2026-08-12. Which are they now? ═══')
const now = await prisma.$queryRaw<Array<{kw:string;ext:string;pushed:boolean}>>`
  WITH f AS (SELECT DISTINCT ON ("entityId") "entityId" FROM "AdvertisingActionLog"
             WHERE "actionType"='create_keyword' AND "userId"='automation:auto-harvest' ORDER BY "entityId","createdAt" ASC),
  p AS (SELECT DISTINCT "entityId" FROM "AdvertisingActionLog" WHERE "actionType"='push_keyword')
  SELECT t."expressionValue" AS kw, t."externalTargetId" AS ext, (p."entityId" IS NOT NULL) AS pushed
  FROM "AdTarget" t JOIN f ON f."entityId"=t.id LEFT JOIN p ON p."entityId"=t.id
  WHERE t."isNegative"=false AND t."externalTargetId" IS NOT NULL ORDER BY t."createdAt"`
for (const r of now) console.log(`  ${r.pushed?'pushed today ':'pre-existing '} "${String(r.kw).slice(0,30).padEnd(32)}" ${r.ext}`)
console.log(`  → ${now.length} at Amazon · ${now.filter(r=>r.pushed).length} carry a push log · ${now.filter(r=>!r.pushed).length} do not`)
await prisma.$disconnect()
