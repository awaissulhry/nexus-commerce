/** HV.8a — pick the ONE negative to prove the fixed path. READ-ONLY: previewHarvest only. */
import '../src/env.js'
const { previewHarvest } = await import('../src/services/advertising/ads-harvest.service.js')
const { default: prisma } = await import('../src/db.js')
const eur=(c:number)=>`€${(c/100).toFixed(2)}`
const p = await previewHarvest({ windowDays: 60, minSpendCents: 1000, minOrders: 2 })
console.log(`\npreview: ${p.negatives.length} negatives · ${p.graduations.length} graduations (window ${p.windowDays}d)\n`)
const prot = await prisma.adKeywordProtection.findMany({ select:{ term:true, mode:true } })
console.log(`protected terms (${prot.length}): ${prot.map(x=>`${x.term}[${x.mode}]`).join(' · ')}\n`)
const camps = await prisma.campaign.findMany({ where:{ externalCampaignId:{ not:null } }, select:{ externalCampaignId:true, name:true, marketplace:true, status:true } })
const byExt = new Map(camps.map(c=>[c.externalCampaignId!, c]))
const WRITE_ENABLED = new Set(['DE','IT','FR','ES'])
console.log('candidate negatives, richest first:')
for (const n of p.negatives.slice(0,12) as any[]) {
  const c = byExt.get(n.externalCampaignId)
  const ag = await prisma.adGroup.findFirst({ where:{ externalAdGroupId:n.externalAdGroupId }, select:{ name:true } })
  const hit = prot.find(x=>n.query.toLowerCase().includes(x.term.toLowerCase()))
  console.log(`  ${eur(n.costCents).padStart(9)} clicks=${String(n.clicks ?? '?').padStart(4)} "${String(n.query).slice(0,34).padEnd(36)}" ${c?.marketplace ?? '?'} ${WRITE_ENABLED.has(c?.marketplace ?? '')?'WRITABLE':'no-write'} ${String(c?.status).padEnd(9)} ${String(c?.name ?? '—').slice(0,26)} › ${String(ag?.name ?? '—').slice(0,20)}${hit?`  🔴 PROTECTED(${hit.term})`:''}`)
}
await prisma.$disconnect()
