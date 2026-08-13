/**
 * HV.8a — the blast radius of moving the default to AD_GROUP. READ-ONLY.
 *
 * The existing 20 rows are CAMPAIGN-scope and `negativeExistsLocally` filters on `negativeLevel`,
 * so an AD_GROUP write does NOT dedupe against them. This measures exactly how many real writes
 * the first armed run would attempt.
 */
import '../src/env.js'
const { previewHarvest } = await import('../src/services/advertising/ads-harvest.service.js')
const { default: prisma } = await import('../src/db.js')
const eur=(c:number)=>`€${(c/100).toFixed(2)}`

// 🔴 The ENGINE's own call is `previewHarvest({})` (ads-auto-harvest.service.ts:102) — all
// defaults, so €15 not €10. Measuring with any other parameters describes a run that never happens.
const p = await previewHarvest({})
const SPELLINGS = ['NEGATIVE_EXACT','EXACT']
let wouldWrite = 0, wouldDedupe = 0, noAdGroup = 0
let spend = 0
console.log(`\n═══ the ${p.negatives.length} wasteful candidates, under the NEW default ═══\n`)
for (const n of p.negatives as any[]) {
  const camp = await prisma.campaign.findFirst({ where:{ externalCampaignId: n.externalCampaignId }, select:{ id:true, name:true, marketplace:true } })
  const ag = camp ? await prisma.adGroup.findFirst({ where:{ externalAdGroupId: n.externalAdGroupId, campaignId: camp.id }, select:{ id:true, name:true } }) : null
  if (!ag) { noAdGroup++; console.log(`  ⚠ no local ad group   "${String(n.query).slice(0,32)}"`); continue }
  const dupAG = await prisma.adTarget.findFirst({ where:{ adGroupId: ag.id, isNegative:true, negativeLevel:'AD_GROUP', expressionValue:n.query, expressionType:{ in: SPELLINGS } }, select:{ id:true } })
  const dupCAMP = await prisma.adTarget.findFirst({ where:{ adGroup:{ campaignId: camp!.id }, isNegative:true, negativeLevel:'CAMPAIGN', expressionValue:n.query, expressionType:{ in: SPELLINGS } }, select:{ id:true, externalTargetId:true } })
  if (dupAG) { wouldDedupe++; console.log(`  · dedupes (AD_GROUP row exists)  ${eur(n.costCents).padStart(8)} "${String(n.query).slice(0,32)}"`) }
  else { wouldWrite++; spend += n.costCents; console.log(`  🔴 WOULD WRITE ${eur(n.costCents).padStart(8)} ${camp!.marketplace} "${String(n.query).slice(0,32).padEnd(34)}" ${String(camp!.name).slice(0,22)} › ${String(ag.name).slice(0,18)}${dupCAMP?`  (a dead CAMPAIGN row exists${dupCAMP.externalTargetId?'':', no Amazon id'})`:''}`) }
}
console.log(`\n  would WRITE ${wouldWrite} · would dedupe ${wouldDedupe} · no local ad group ${noAdGroup} · of ${p.negatives.length}`)
console.log(`  spend behind the writes: ${eur(spend)}`)
console.log(`\n  Under the OLD default all ${p.negatives.length} would dedupe against the CAMPAIGN rows or write new dead ones.`)
await prisma.$disconnect()
