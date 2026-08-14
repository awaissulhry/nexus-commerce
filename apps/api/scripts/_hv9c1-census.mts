/**
 * HV.9c.1 — THE DE-DUP CENSUS. READ-ONLY, authoritative. Everything downstream cites this.
 */
import '../src/env.js'
const { default: prisma } = await import('../src/db.js')
const int=(n:any)=>Number(n).toLocaleString('en-IE')
const isAsin=(s:string)=>/^b0[a-z0-9]{8}$/i.test(String(s).trim())

// the engine-harvested cohort, exactly as HV.5 defined it
const cohort = await prisma.$queryRaw<Array<{id:string;kw:string;mt:string;ext:string|null;created:Date;agid:string;ag:string;camp:string;mkt:string;ctt:string|null}>>`
  WITH f AS (SELECT DISTINCT ON ("entityId") "entityId" FROM "AdvertisingActionLog"
             WHERE "actionType"='create_keyword' AND "userId"='automation:auto-harvest' ORDER BY "entityId","createdAt" ASC)
  SELECT t.id, t."expressionValue" AS kw, t."expressionType" AS mt, t."externalTargetId" AS ext,
         t."createdAt" AS created, g.id AS agid, g.name AS ag, c.name AS camp, c.marketplace AS mkt, c."targetingType" AS ctt
  FROM "AdTarget" t JOIN f ON f."entityId"=t.id
  JOIN "AdGroup" g ON g.id=t."adGroupId" JOIN "Campaign" c ON c.id=g."campaignId"
  WHERE t."isNegative"=false ORDER BY t."createdAt"`
const local = cohort.filter(r=>!r.ext)
console.log(`\n═══ cohort: ${cohort.length} · at Amazon ${cohort.length-local.length} · local-only ${local.length} ═══`)

// ── 1 · duplicate groups among the local-only rows, keyed (adGroup, matchType, text)
const key=(r:typeof local[0])=>`${r.agid}|${r.mt}|${r.kw.trim().toLowerCase()}`
const groups=new Map<string,typeof local>()
for (const r of local) { const a=groups.get(key(r))??[]; a.push(r); groups.set(key(r),a) }
const dupes=[...groups.values()].filter(g=>g.length>1).sort((a,b)=>b.length-a.length)
const singles=[...groups.values()].filter(g=>g.length===1)
console.log(`\n═══ 1 · duplicate groups: ${dupes.length} · rows inside them: ${dupes.reduce((s,g)=>s+g.length,0)} ═══`)
for (const g of dupes) {
  const r=g[0], span=`${g[0].created.toISOString().slice(0,10)} → ${g[g.length-1].created.toISOString().slice(0,10)}`
  // does a SIBLING outside the local-only set already hold this keyword at Amazon?
  const twin = cohort.find(x=>x.ext && x.agid===r.agid && x.mt===r.mt && x.kw.trim().toLowerCase()===r.kw.trim().toLowerCase())
  console.log(`  ×${String(g.length).padStart(3)} ${r.mkt} ${String(r.camp).slice(0,26).padEnd(28)} › ${String(r.ag).slice(0,20).padEnd(22)} ${r.mt.padEnd(6)} "${String(r.kw).slice(0,26)}"  ${span}${twin?`  🔴 a sibling already holds it at Amazon (${twin.ext})`:''}`)
}
console.log(`\n═══ 2 · THE HEADLINE ═══`)
const asinRows=local.filter(r=>isAsin(r.kw)), autoRows=local.filter(r=>r.ctt==='AUTO')
const realGroups=[...groups.values()].filter(g=>!isAsin(g[0].kw) && g[0].ctt!=='AUTO')
console.log(`  local-only rows:                 ${local.length}`)
console.log(`  distinct (adGroup,match,text):   ${groups.size}`)
console.log(`  🔴 distinct AND pushable:         ${realGroups.length}   ← the real backlog`)
console.log(`     (excludes ${asinRows.length} ASIN rows and ${autoRows.length} AUTO-campaign rows)`)

console.log(`\n═══ 4 · singletons among the pushable groups ═══`)
for (const g of realGroups.filter(g=>g.length===1)) console.log(`  ${g[0].mkt} ${String(g[0].camp).slice(0,24)} › ${String(g[0].ag).slice(0,18)} "${String(g[0].kw).slice(0,26)}" ${g[0].created.toISOString().slice(0,10)}`)

console.log(`\n═══ 5 · the 54 ASIN rows ═══`)
const byAsin=new Map<string,number>(); for(const a of asinRows) byAsin.set(a.kw.toLowerCase(),(byAsin.get(a.kw.toLowerCase())??0)+1)
console.log(`  ${asinRows.length} rows · ${byAsin.size} ASINs: ${[...byAsin].map(([k,v])=>`${k} ×${v}`).join(' · ')}`)
console.log(`  with an Amazon id: ${asinRows.filter(r=>r.ext).length} · distinct ad groups: ${new Set(asinRows.map(r=>r.agid)).size}`)
console.log(`\n═══ 6 · rows under AUTO campaigns ═══`)
for (const r of autoRows) console.log(`  ${r.mkt} ${r.camp} › ${r.ag} "${r.kw}" id=${r.id}`)
await prisma.$disconnect()
