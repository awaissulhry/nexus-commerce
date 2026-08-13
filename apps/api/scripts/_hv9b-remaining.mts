/** HV.9b — the remaining pushable ids, with the two AUTO-campaign rows excluded. READ-ONLY. */
import '../src/env.js'
const { default: prisma } = await import('../src/db.js')
const rows = await prisma.$queryRaw<Array<{id:string;kw:string;mkt:string;camp:string;ctt:string|null}>>`
  WITH f AS (SELECT DISTINCT ON ("entityId") "entityId" FROM "AdvertisingActionLog"
             WHERE "actionType"='create_keyword' AND "userId"='automation:auto-harvest' ORDER BY "entityId","createdAt" ASC)
  SELECT t.id, t."expressionValue" AS kw, c.marketplace AS mkt, c.name AS camp, c."targetingType" AS ctt
  FROM "AdTarget" t JOIN f ON f."entityId"=t.id
  JOIN "AdGroup" g ON g.id=t."adGroupId" JOIN "Campaign" c ON c.id=g."campaignId"
  WHERE t."externalTargetId" IS NULL AND t."isNegative"=false
    AND t."expressionValue" !~* '^b0[a-z0-9]{8}$'
  ORDER BY c.marketplace, c.name`
const auto = rows.filter(r => r.ctt === 'AUTO')
const push = rows.filter(r => r.ctt !== 'AUTO')
console.log(`\n  local-only non-ASIN remaining: ${rows.length}`)
console.log(`  🔴 excluded — AUTO campaign (a keyword cannot exist there): ${auto.length}`)
for (const a of auto) console.log(`      ${a.mkt} "${a.kw}" ${a.camp}  id=${a.id}`)
console.log(`  pushable now: ${push.length}`)
const BATCH = 25
for (let i=0;i<push.length;i+=BATCH) {
  console.log(`\nBATCH ${Math.floor(i/BATCH)+2} (${push.slice(i,i+BATCH).length}): ${JSON.stringify(push.slice(i,i+BATCH).map(r=>r.id))}`)
}
await prisma.$disconnect()
