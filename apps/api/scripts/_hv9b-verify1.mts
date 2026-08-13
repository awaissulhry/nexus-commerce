/** HV.9b — verify batch 1 locally + explain the one failure. READ-ONLY. */
import '../src/env.js'
const { default: prisma } = await import('../src/db.js')
const IDS=["cmrrf241x0f4loe019bndsgzo","cmpugtii80003pe01ilkydslr","cmq1z48ks009lqm01jaf6iccd","cmqhoyxls00t5od01dgk8gwro","cmputwysf02ndqq01rjcsx5pk"]
console.log('\n═══ batch 1 rows, after the push ═══')
for (const id of IDS) {
  const t = await prisma.adTarget.findUnique({ where:{ id }, select:{ expressionValue:true, expressionType:true, bidCents:true, externalTargetId:true, lastSyncStatus:true,
    adGroup:{ select:{ name:true, targetingType:true, externalAdGroupId:true, campaign:{ select:{ name:true, marketplace:true, targetingType:true } } } } } })
  console.log(`  ${t?.externalTargetId ? '✅' : '🔴'} ${String(t?.expressionValue).slice(0,28).padEnd(30)} ext=${t?.externalTargetId ?? 'NULL'} sync=${t?.lastSyncStatus ?? '—'}`)
  console.log(`      ${t?.adGroup?.campaign?.marketplace} ${t?.adGroup?.campaign?.name} › ${t?.adGroup?.name}  campaignTargeting=${t?.adGroup?.campaign?.targetingType} adGroupTargeting=${t?.adGroup?.targetingType}`)
}
console.log('\n═══ 🔴 how much of the 155 sits in AUTO-targeted ad groups? ═══')
const rows = await prisma.$queryRaw<Array<{tt:string|null;ctt:string|null;n:bigint}>>`
  WITH f AS (SELECT DISTINCT ON ("entityId") "entityId" FROM "AdvertisingActionLog"
             WHERE "actionType"='create_keyword' AND "userId"='automation:auto-harvest' ORDER BY "entityId","createdAt" ASC)
  SELECT g."targetingType" AS tt, c."targetingType" AS ctt, COUNT(*)::bigint AS n
  FROM "AdTarget" t JOIN f ON f."entityId"=t.id
  JOIN "AdGroup" g ON g.id=t."adGroupId" JOIN "Campaign" c ON c.id=g."campaignId"
  WHERE t."externalTargetId" IS NULL AND t."isNegative"=false AND t."expressionValue" !~* '^b0[a-z0-9]{8}$'
  GROUP BY 1,2 ORDER BY 3 DESC`
for (const r of rows) console.log(`  adGroup=${String(r.tt).padEnd(10)} campaign=${String(r.ctt).padEnd(10)} → ${Number(r.n)} rows`)
console.log('\n  → a keyword cannot exist in an AUTO-targeted ad group; Amazon accepts the call and creates nothing.')
await prisma.$disconnect()
