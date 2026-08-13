/** HV.9a — WHY does the destination not resolve for motorradjacke 4xl? READ-ONLY. */
import '../src/env.js'
const { default: prisma } = await import('../src/db.js')
const dest = await prisma.adsHarvestDestination.findFirst()
const scopeCamp = await prisma.campaign.findUnique({ where:{ id: dest!.scopeId }, select:{ id:true, name:true, marketplace:true, externalCampaignId:true } })
console.log(`\n  the ONE destination row is scoped to campaign: ${scopeCamp?.name} (${scopeCamp?.marketplace}) id=${scopeCamp?.id} ext=${scopeCamp?.externalCampaignId}`)
const srcCamp = await prisma.campaign.findFirst({ where:{ externalCampaignId:'115625353077718' }, select:{ id:true, name:true, marketplace:true } })
console.log(`  write 1's SOURCE campaign:                     ${srcCamp?.name} (${srcCamp?.marketplace}) id=${srcCamp?.id}`)
console.log(`\n  🔴 same campaign? ${scopeCamp?.id === srcCamp?.id ? 'YES' : 'NO — the destination does not cover this candidate'}`)
// which candidates DOES the one destination cover?
const { previewHarvest } = await import('../src/services/advertising/ads-harvest.service.js')
const p = await previewHarvest({})
console.log(`\n  today's 13 graduations, by source campaign:`)
for (const g of (p.graduations as any[])) {
  const c = await prisma.campaign.findFirst({ where:{ externalCampaignId:g.externalCampaignId }, select:{ id:true, name:true, marketplace:true } })
  const covered = c?.id === dest!.scopeId
  console.log(`    ${covered?'✅ COVERED':'⛔ no dest '} ${String(g.query).slice(0,32).padEnd(34)} ${c?.marketplace} ${String(c?.name).slice(0,30)}`)
}
await prisma.$disconnect()
