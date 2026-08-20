/** HV-R P3a — is there a NON-GUESSED signal for an ad group's match role? READ-ONLY. */
import '../src/env.js'
const { default: prisma } = await import('../src/db.js')
const L: string[] = []; const p = (s: string) => L.push(s)

const agtt = await prisma.$queryRaw<Array<{tt:string|null;n:bigint}>>`SELECT "targetingType"::text tt, COUNT(*) n FROM "AdGroup" GROUP BY 1 ORDER BY 2 DESC`
p(`AdGroup.targetingType: ${agtt.map(r=>`${r.tt ?? 'NULL'}=${r.n}`).join(' · ')}`)

// what match types do the POSITIVE targets in each ad group actually use?
const byAg = await prisma.$queryRaw<Array<{agid:string;mts:string;n:bigint}>>`
  SELECT t."adGroupId" agid,
         string_agg(DISTINCT upper(t."expressionType"::text), ',' ORDER BY upper(t."expressionType"::text)) mts,
         COUNT(*) n
  FROM "AdTarget" t WHERE t."isNegative"=false GROUP BY 1`
p(`\nad groups with >=1 positive target: ${byAg.length} of 289`)
const combo = new Map<string, number>()
for (const r of byAg) combo.set(r.mts, (combo.get(r.mts) ?? 0) + 1)
p(`distinct match-type SETS across ad groups:`)
for (const [k,v] of [...combo].sort((a,b)=>b[1]-a[1])) p(`   ${k}: ${v} ad groups`)

// agreement between the NAME guess and the targets actually present
const rows = await prisma.$queryRaw<Array<{agid:string;ag:string;ctt:string|null}>>`
  SELECT g.id agid, g.name ag, c."targetingType"::text ctt FROM "AdGroup" g JOIN "Campaign" c ON c.id=g."campaignId"`
const nameRole = (n:string, ctt:string|null) => ctt==='AUTO' ? 'AUTO'
  : /(^|[^a-z])exact([^a-z]|$)/i.test(n) ? 'EXACT'
  : /(^|[^a-z])phrase([^a-z]|$)/i.test(n) ? 'PHRASE'
  : /(^|[^a-z])broad([^a-z]|$)/i.test(n) ? 'BROAD' : 'unclassified'
const mtsById = new Map(byAg.map(r=>[r.agid, r.mts]))
let agree=0, disagree=0, nameBlankTargetsKnow=0, bothBlank=0
const examples:string[]=[]
for (const r of rows) {
  const nr = nameRole(r.ag, r.ctt)
  const mts = mtsById.get(r.agid) ?? ''
  if (nr==='AUTO') continue
  if (nr==='unclassified' && mts) { nameBlankTargetsKnow++; if(examples.length<6) examples.push(`   name says nothing · targets say [${mts}] · "${r.ag}"`) }
  else if (nr==='unclassified' && !mts) bothBlank++
  else if (mts.includes(nr)) agree++
  else if (mts) { disagree++; if(examples.length<12) examples.push(`   🔴 name says ${nr} · targets say [${mts}] · "${r.ag}"`) }
}
p(`\nNAME guess vs TARGETS actually present (non-AUTO ad groups):`)
p(`   agree ${agree} · DISAGREE ${disagree} · name blank but targets known ${nameBlankTargetsKnow} · both blank ${bothBlank}`)
for (const e of examples) p(e)
console.log(L.join('\n')); await prisma.$disconnect()
