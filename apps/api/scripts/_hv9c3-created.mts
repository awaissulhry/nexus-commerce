/** 🔴 HV.9c.3 — did today's 54 pushes create ANY keyword at Amazon? READ-ONLY.
 *  A keyword created 2026-08-13 cannot have July performance. entityId is Amazon's id. */
import '../src/env.js'
const { default: prisma } = await import('../src/db.js')
const IDS=['252943870004724','126731108917969','156132292838069','16026030732543','169513143345169','204988683848148']
console.log('\n═══ performance history BY AMAZON ID (entityId), ignoring our rows entirely ═══')
for (const ext of IDS) {
  const r = await prisma.$queryRaw<Array<{n:bigint;first:Date|null;last:Date|null;imp:bigint|null}>>`
    SELECT COUNT(*)::bigint AS n, MIN(date) AS first, MAX(date) AS last, SUM(impressions)::bigint AS imp
    FROM "AmazonAdsDailyPerformance" WHERE "entityType"='AD_TARGET' AND "entityId"=${ext}`
  const x=r[0]
  const pre = x.first && x.first < new Date('2026-08-13T00:00:00Z')
  console.log(`  ${ext}  rows=${String(Number(x.n)).padStart(3)} ${x.first?`${x.first.toISOString().slice(0,10)} → ${x.last?.toISOString().slice(0,10)} imp=${Number(x.imp??0)}`:'(no performance at all)'}  ${pre?'🔴 EXISTED BEFORE TODAY':'← no pre-today history'}`)
}
console.log('\n═══ so how many keywords did the 54 pushes actually create? ═══')
let created=0, pre=0
for (const ext of IDS) {
  const r = await prisma.$queryRaw<Array<{first:Date|null}>>`
    SELECT MIN(date) AS first FROM "AmazonAdsDailyPerformance" WHERE "entityType"='AD_TARGET' AND "entityId"=${ext}`
  if (r[0].first && r[0].first < new Date('2026-08-13T00:00:00Z')) pre++; else created++
}
console.log(`  provably pre-existing: ${pre} · no pre-today evidence: ${created}`)
console.log('  (a keyword with July performance cannot have been created on 2026-08-13)')
await prisma.$disconnect()
