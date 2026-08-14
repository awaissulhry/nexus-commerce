/** HV.9c.2 — what would deleting the redundant rows orphan? READ-ONLY. Nothing is deleted. */
import '../src/env.js'
const { default: prisma } = await import('../src/db.js')
const int=(n:any)=>Number(n).toLocaleString('en-IE')
const isAsin=(s:string)=>/^b0[a-z0-9]{8}$/i.test(String(s).trim())

const cohort = await prisma.$queryRaw<Array<{id:string;kw:string;mt:string;ext:string|null;created:Date;agid:string;ctt:string|null}>>`
  WITH f AS (SELECT DISTINCT ON ("entityId") "entityId" FROM "AdvertisingActionLog"
             WHERE "actionType"='create_keyword' AND "userId"='automation:auto-harvest' ORDER BY "entityId","createdAt" ASC)
  SELECT t.id, t."expressionValue" AS kw, t."expressionType" AS mt, t."externalTargetId" AS ext,
         t."createdAt" AS created, g.id AS agid, c."targetingType" AS ctt
  FROM "AdTarget" t JOIN f ON f."entityId"=t.id
  JOIN "AdGroup" g ON g.id=t."adGroupId" JOIN "Campaign" c ON c.id=g."campaignId"
  WHERE t."isNegative"=false ORDER BY t."createdAt"`

// apply the keep rule: hold the id if any; else the OLDEST row
const key=(r:any)=>`${r.agid}|${r.mt}|${r.kw.trim().toLowerCase()}`
const groups=new Map<string,typeof cohort>()
for (const r of cohort) { const a=groups.get(key(r))??[]; a.push(r); groups.set(key(r),a) }
const doomed: typeof cohort = []
for (const g of groups.values()) {
  if (g.length===1) continue
  const withExt = g.filter(r=>r.ext)
  const keep = withExt[0] ?? [...g].sort((a,b)=>+a.created-+b.created)[0]
  doomed.push(...g.filter(r=>r.id!==keep.id))
}
const asins = cohort.filter(r=>isAsin(r.kw))
const autos = cohort.filter(r=>r.ctt==='AUTO')
const allDoomed = new Set([...doomed.map(r=>r.id), ...asins.map(r=>r.id), ...autos.map(r=>r.id)])
console.log(`\n═══ proposed deletion set ═══`)
console.log(`  redundant duplicates (keep rule applied): ${doomed.length}`)
console.log(`  ASIN rows:                                ${asins.length}`)
console.log(`  AUTO-campaign rows:                       ${autos.length}`)
console.log(`  🔴 union (overlaps removed):               ${allDoomed.size}`)
console.log(`  survivors in the cohort:                  ${cohort.length - allDoomed.size}`)

console.log(`\n═══ 🔴 what references those rows? ═══`)
const ids=[...allDoomed]
const logs = await prisma.$queryRaw<Array<{t:string;n:bigint}>>`
  SELECT "actionType" AS t, COUNT(*)::bigint AS n FROM "AdvertisingActionLog"
  WHERE "entityId" = ANY(${ids}) GROUP BY 1 ORDER BY 2 DESC`
let tot=0; for (const l of logs) { tot+=Number(l.n); console.log(`  AdvertisingActionLog.${String(l.t).padEnd(26)} ${int(l.n)}`) }
console.log(`  → ${int(tot)} audit rows reference a row proposed for deletion`)
const perf = await prisma.$queryRaw<Array<{n:bigint}>>`
  SELECT COUNT(*)::bigint AS n FROM "AmazonAdsDailyPerformance" WHERE "entityType"='AD_TARGET' AND "localEntityId" = ANY(${ids})`
console.log(`  AmazonAdsDailyPerformance rows:            ${int(perf[0].n)}`)
const sugg = await prisma.$queryRaw<Array<{n:bigint}>>`SELECT COUNT(*)::bigint AS n FROM "AdsRuleSuggestion" WHERE "entityId" = ANY(${ids})`
console.log(`  AdsRuleSuggestion rows:                    ${int(sugg[0].n)}`)
console.log(`\n  🔴 AdvertisingActionLog has NO foreign key to AdTarget (entityId is a bare string),`)
console.log(`     so deleting a row does NOT cascade — the audit rows SURVIVE, pointing at an id that`)
console.log(`     no longer resolves. The trail is kept; its subject is gone.`)
await prisma.$disconnect()
