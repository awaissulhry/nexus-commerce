/**
 * HV.9c.5 — settle the census AGAINST AMAZON. READ-ONLY: listKeywords only, 2 calls.
 * Run: railway run npx tsx scripts/_hv9c5-amazon.mts
 */
import '../src/env.js'
const { adsMode, listKeywords } = await import('../src/services/advertising/ads-api-client.js')
const { default: prisma } = await import('../src/db.js')
if (adsMode() !== 'live') { console.error('🔴 adsMode is not live — a sandbox read returns [] and proves nothing.'); process.exit(1) }
const isAsin=(s:string)=>/^b0[a-z0-9]{8}$/i.test(String(s).trim())

const cohort = await prisma.$queryRaw<Array<{id:string;kw:string;mt:string;agid:string;ag:string;agext:string|null;camp:string;campext:string|null;mkt:string;ctt:string|null}>>`
  WITH f AS (SELECT DISTINCT ON ("entityId") "entityId" FROM "AdvertisingActionLog"
             WHERE "actionType"='create_keyword' AND "userId"='automation:auto-harvest' ORDER BY "entityId","createdAt" ASC)
  SELECT t.id, t."expressionValue" AS kw, t."expressionType" AS mt, g.id AS agid, g.name AS ag,
         g."externalAdGroupId" AS agext, c.name AS camp, c."externalCampaignId" AS campext, c.marketplace AS mkt, c."targetingType" AS ctt
  FROM "AdTarget" t JOIN f ON f."entityId"=t.id
  JOIN "AdGroup" g ON g.id=t."adGroupId" JOIN "Campaign" c ON c.id=g."campaignId"
  WHERE t."isNegative"=false AND t."externalTargetId" IS NULL`
const key=(r:any)=>`${r.agid}|${r.mt}|${r.kw.trim().toLowerCase()}`
const groups=new Map<string,typeof cohort>()
for (const r of cohort) { const a=groups.get(key(r))??[]; a.push(r); groups.set(key(r),a) }
const real=[...groups.values()].filter(g=>!isAsin(g[0].kw) && g[0].ctt!=='AUTO')

const byProfile: Record<string,{profile:string;camps:string[]}> = {
  IT: { profile:'4117374346144545', camps:[] }, DE: { profile:'2009298984696893', camps:[] },
}
for (const g of real) if (g[0].campext) { const b=byProfile[g[0].mkt]; if (b && !b.camps.includes(g[0].campext)) b.camps.push(g[0].campext) }

const live = new Map<string, any[]>()
for (const [mkt,b] of Object.entries(byProfile)) {
  if (!b.camps.length) continue
  const kws = await listKeywords({ profileId: b.profile, region:'EU' }, { campaignIds: b.camps })
  live.set(mkt, kws as any[])
  console.log(`  ${mkt}: ${kws.length} keywords read across ${b.camps.length} campaigns (1 call + pagination)`)
}

console.log(`\n═══ per group, settled against Amazon ═══`)
let pushCandidates=0, existsBound=0, existsUnbound=0
for (const g of real) {
  const r=g[0]
  const kws = live.get(r.mkt) ?? []
  const hit = kws.find(k => String(k.keywordText??'').trim().toLowerCase() === r.kw.trim().toLowerCase()
    && String(k.matchType??'').toUpperCase() === String(r.mt).toUpperCase()
    && String(k.adGroupId??'') === String(r.agext??''))
  let owner: {id:string}|null = null
  if (hit?.keywordId) owner = await prisma.adTarget.findFirst({ where:{ externalTargetId:String(hit.keywordId) }, select:{ id:true } })
  const disp = !hit ? '🔴 GENUINE PUSH CANDIDATE' : owner ? 'archive all (a row holds it)' : '🔴 UNBOUND at Amazon — reconciler'
  if (!hit) pushCandidates++; else if (owner) existsBound++; else existsUnbound++
  console.log(`  ×${String(g.length).padStart(2)} ${r.mkt} ${String(r.camp).slice(0,24).padEnd(26)} "${String(r.kw).slice(0,38).padEnd(40)}" ${hit?`EXISTS id=${hit.keywordId} state=${hit.state} bid=${hit.bid}`:'NOT AT AMAZON'}  → ${disp}`)
}
console.log(`\n  exists & bound: ${existsBound} · exists but UNBOUND: ${existsUnbound} · 🔴 RESIDUAL PUSH CANDIDATES: ${pushCandidates}`)

console.log(`\n═══ 204988683848148 — existing-but-never-served, or created by the push? ═══`)
const de = live.get('DE') ?? []
const d = de.find(k => String(k.keywordId)==='204988683848148')
console.log(`  ${d ? `FOUND: "${d.keywordText}" ${d.matchType} state=${d.state} bid=${d.bid} ag=${d.adGroupId}` : '🔴 NOT in the campaigns read'}`)
process.exit(0)
