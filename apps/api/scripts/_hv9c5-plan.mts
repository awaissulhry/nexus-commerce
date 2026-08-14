/** HV.9c.5 — the Amazon read PLAN. READ-ONLY, DB only. Makes ZERO Amazon calls. */
import '../src/env.js'
const { default: prisma } = await import('../src/db.js')
const isAsin=(s:string)=>/^b0[a-z0-9]{8}$/i.test(String(s).trim())
const cohort = await prisma.$queryRaw<Array<{id:string;kw:string;mt:string;ext:string|null;agid:string;ag:string;agext:string|null;camp:string;campext:string|null;mkt:string;ctt:string|null}>>`
  WITH f AS (SELECT DISTINCT ON ("entityId") "entityId" FROM "AdvertisingActionLog"
             WHERE "actionType"='create_keyword' AND "userId"='automation:auto-harvest' ORDER BY "entityId","createdAt" ASC)
  SELECT t.id, t."expressionValue" AS kw, t."expressionType" AS mt, t."externalTargetId" AS ext,
         g.id AS agid, g.name AS ag, g."externalAdGroupId" AS agext,
         c.name AS camp, c."externalCampaignId" AS campext, c.marketplace AS mkt, c."targetingType" AS ctt
  FROM "AdTarget" t JOIN f ON f."entityId"=t.id
  JOIN "AdGroup" g ON g.id=t."adGroupId" JOIN "Campaign" c ON c.id=g."campaignId"
  WHERE t."isNegative"=false AND t."externalTargetId" IS NULL`
const key=(r:any)=>`${r.agid}|${r.mt}|${r.kw.trim().toLowerCase()}`
const groups=new Map<string,typeof cohort>()
for (const r of cohort) { const a=groups.get(key(r))??[]; a.push(r); groups.set(key(r),a) }
const real=[...groups.values()].filter(g=>!isAsin(g[0].kw) && g[0].ctt!=='AUTO')
console.log(`\n═══ groups needing an Amazon answer ═══`)
console.log(`  local-only rows ${cohort.length} · distinct groups ${groups.size} · excluding ASIN+AUTO: ${real.length}`)
const camps=new Map<string,{mkt:string;name:string}>()
for (const g of real) if (g[0].campext) camps.set(g[0].campext, { mkt:g[0].mkt, name:g[0].camp })
console.log(`\n  distinct campaigns to read: ${camps.size}`)
for (const [ext,c] of camps) console.log(`    ${c.mkt} ${String(c.name).slice(0,34).padEnd(36)} ext=${ext}`)
const byMkt=new Map<string,number>(); for (const c of camps.values()) byMkt.set(c.mkt,(byMkt.get(c.mkt)??0)+1)
console.log(`\n  by marketplace (= one profile, one connection each): ${[...byMkt].map(([k,v])=>`${k}=${v}`).join(' · ')}`)
console.log(`\n═══ the groups themselves ═══`)
for (const g of real) console.log(`  ×${String(g.length).padStart(2)} ${g[0].mkt} ${String(g[0].camp).slice(0,26).padEnd(28)} › ${String(g[0].ag).slice(0,18).padEnd(20)} ${g[0].mt.padEnd(6)} "${g[0].kw}"`)
console.log(`\n  🔴 also to resolve: 204988683848148 "dünne motorradjacke mit protektoren" — zero performance, provenance unknown`)
await prisma.$disconnect()
