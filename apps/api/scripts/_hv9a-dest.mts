/** HV.9a — the destination state. READ-ONLY. */
import '../src/env.js'
const { default: prisma } = await import('../src/db.js')
const rows = await prisma.adsHarvestDestination.findMany()
console.log(`\n═══ AdsHarvestDestination rows: ${rows.length} ═══`)
for (const r of rows as any[]) console.log(`  grain=${r.scopeGrain} scopeId=${r.scopeId} matchType=${r.matchType} → adGroupId=${r.adGroupId} negateAtSource=${r.negateAtSource}`)
for (const r of rows as any[]) {
  const ag = await prisma.adGroup.findUnique({ where:{ id: r.adGroupId }, select:{ name:true, campaign:{ select:{ name:true, marketplace:true } } } })
  console.log(`    resolves to: ${ag?.campaign?.marketplace} · ${ag?.campaign?.name} › ${ag?.name}`)
}
console.log('\n═══ does DE_Exact_3_Keywords exist, and what ad groups does it have? ═══')
const c = await prisma.campaign.findFirst({ where:{ name:{ contains:'DE_Exact_3' } }, select:{ id:true, name:true, marketplace:true, status:true, externalCampaignId:true, adGroups:{ select:{ id:true, name:true, externalAdGroupId:true } } } })
console.log(`  ${c ? `${c.name} (${c.marketplace}, ${c.status}, ext=${c.externalCampaignId})` : '🔴 NOT FOUND'}`)
for (const g of c?.adGroups ?? []) console.log(`    ad group: ${g.name} id=${g.id} ext=${g.externalAdGroupId}`)
console.log('\n═══ how many of today’s 13 graduations are promotable? ═══')
const { planPromotion } = await import('../src/services/advertising/harvest-promote.service.js')
const { previewHarvest } = await import('../src/services/advertising/ads-harvest.service.js')
const p = await previewHarvest({})
const ids = (p.graduations as any[]).map(g => {
  return `${'DE'}|${g.externalCampaignId}|${g.externalAdGroupId}|${g.query}`
})
const plan = await planPromotion({ market: 'all', candidateIds: ids, userId: 'preflight' })
console.log(`  promotable=${plan.promotable} blocked=${plan.blocked} of ${plan.rows.length}`)
for (const r of plan.rows as any[]) console.log(`    ${r.promotable?'✅':'⛔'} ${String(r.term).slice(0,32).padEnd(34)} dest=${r.destinationAdGroupName || '—'} ${r.blocked?`blocked=${r.blocked.deniedAt}`:''}`)
await prisma.$disconnect()
