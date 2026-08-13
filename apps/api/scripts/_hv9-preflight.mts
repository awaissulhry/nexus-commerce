/** HV.9 — preflight. READ-ONLY. Are the two authorised writes still the right rows? */
import '../src/env.js'
const { previewHarvest } = await import('../src/services/advertising/ads-harvest.service.js')
const { default: prisma } = await import('../src/db.js')
const eur=(c:number)=>`€${(c/100).toFixed(2)}`
const int=(n:any)=>Number(n).toLocaleString('en-IE')

console.log('\n═══ 1 · today’s candidates (engine params: previewHarvest({})) ═══')
const p = await previewHarvest({})
console.log(`  negatives=${p.negatives.length} graduations=${p.graduations.length} window=${p.windowDays}d`)

const W1 = 'motorradjacke 4xl', W2 = 'veste moto homme homologué'
const g1 = (p.graduations as any[]).find(g => g.query === W1)
const n2 = (p.negatives as any[]).find(n => n.query === W2)
console.log(`\n  WRITE 1 "${W1}" as a GRADUATION candidate: ${g1 ? 'PRESENT' : '🔴 ABSENT'}`)
if (g1) console.log(`    orders=${g1.orders} clicks=${g1.clicks} spend=${eur(g1.costCents)} sales=${eur(g1.salesCents)} cpc=${g1.clicks?eur(Math.round(g1.costCents/g1.clicks)):'—'} camp=${g1.externalCampaignId} ag=${g1.externalAdGroupId}`)
console.log(`  WRITE 2 "${W2}" as a NEGATIVE candidate: ${n2 ? 'PRESENT' : '🔴 ABSENT'}`)
if (n2) console.log(`    orders=${n2.orders} clicks=${n2.clicks} spend=${eur(n2.costCents)} camp=${n2.externalCampaignId} ag=${n2.externalAdGroupId}`)

console.log('\n  all graduation candidates today:')
for (const g of (p.graduations as any[])) console.log(`    ${String(g.query).slice(0,34).padEnd(36)} orders=${String(g.orders).padStart(3)} clicks=${String(g.clicks).padStart(4)} ${eur(g.costCents).padStart(9)} cpc=${g.clicks?eur(Math.round(g.costCents/g.clicks)):'—'}`)
console.log('\n  all negative candidates today:')
for (const n of (p.negatives as any[])) console.log(`    ${String(n.query).slice(0,34).padEnd(36)} clicks=${String(n.clicks).padStart(4)} ${eur(n.costCents).padStart(9)}`)

console.log('\n═══ 2 · the local-only backlog split ═══')
const rows = await prisma.$queryRaw<Array<{id:string;kw:string;mkt:string|null;camp:string|null;ag:string|null}>>`
  WITH f AS (SELECT DISTINCT ON ("entityId") "entityId" FROM "AdvertisingActionLog"
             WHERE "actionType"='create_keyword' AND "userId"='automation:auto-harvest' ORDER BY "entityId","createdAt" ASC)
  SELECT t.id, t."expressionValue" AS kw, c.marketplace AS mkt, c.name AS camp, g.name AS ag
  FROM "AdTarget" t JOIN f ON f."entityId"=t.id
  JOIN "AdGroup" g ON g.id=t."adGroupId" JOIN "Campaign" c ON c.id=g."campaignId"
  WHERE t."externalTargetId" IS NULL AND t."isNegative"=false`
const isAsin = (s:string)=>/^b0[a-z0-9]{8}$/i.test(String(s).trim())
const asins = rows.filter(r=>isAsin(r.kw)), pushable = rows.filter(r=>!isAsin(r.kw))
console.log(`  local-only harvested keywords: ${rows.length} = ${pushable.length} pushable + ${asins.length} ASIN-shaped`)
const byAsin = new Map<string,number>(); for (const a of asins) byAsin.set(a.kw.toLowerCase(), (byAsin.get(a.kw.toLowerCase())??0)+1)
console.log(`  ASINs: ${[...byAsin].map(([k,v])=>`${k} ×${v}`).join(' · ')}`)
const byMkt = new Map<string,number>(); for (const r of pushable) byMkt.set(r.mkt??'?', (byMkt.get(r.mkt??'?')??0)+1)
console.log(`  pushable by market: ${[...byMkt].map(([k,v])=>`${k}=${v}`).join(' · ')}`)

console.log('\n═══ 3 · the write gate, per market ═══')
const { checkAdsWriteGate } = await import('../src/services/advertising/ads-write-gate.js')
for (const m of ['IT','DE','FR','ES']) {
  const g = await checkAdsWriteGate({ marketplace: m, payloadValueCents: 0 })
  console.log(`  ${m}: ${JSON.stringify(g)}`)
}

console.log('\n═══ 4 · the denominators to reconcile ═══')
const allRules = await prisma.automationRule.count()
const advRules = await prisma.automationRule.count({ where:{ domain:'advertising' } })
console.log(`  rules: ${allRules} all domains · ${advRules} advertising`)
for (const [label, days] of [['all time', null], ['60 days', 60], ['30 days', 30]] as const) {
  const where:any = { matchType: { in: ['TARGETING_EXPRESSION','TARGETING_EXPRESSION_PREDEFINED'] } }
  if (days) where.date = { gte: new Date(Date.now()-days*86400_000) }
  const both = await prisma.amazonAdsSearchTerm.count({ where })
  const pre = await prisma.amazonAdsSearchTerm.count({ where: { ...where, matchType: 'TARGETING_EXPRESSION_PREDEFINED' } })
  const te = await prisma.amazonAdsSearchTerm.count({ where: { ...where, matchType: 'TARGETING_EXPRESSION' } })
  console.log(`  auto-targeting rows ${String(label).padEnd(9)}: both=${int(both)} (PREDEFINED=${int(pre)} + TARGETING_EXPRESSION=${int(te)})`)
}
await prisma.$disconnect()
