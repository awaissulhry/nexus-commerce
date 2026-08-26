import '../src/env.js'
const { default: prisma } = await import('../src/db.js')
const { previewSovRule } = await import('../src/services/advertising/ads-sov-preview.service.js')
const { KT6_SUPPRESSION_CENTS } = await import('../src/services/advertising/kt6-bid-action.js')
// pick campaigns that CONTAIN a currently-suppressed enabled keyword target
const supp = await prisma.adTarget.findMany({ where:{ isNegative:false, kind:'KEYWORD', status:'ENABLED', bidCents:{ lte:KT6_SUPPRESSION_CENTS } }, select:{ adGroup:{ select:{ campaignId:true } } }, take:200 })
const ids=[...new Set(supp.map(t=>t.adGroup?.campaignId).filter(Boolean) as string[])].slice(0,3)
const camps = await prisma.campaign.findMany({ where:{ id:{ in:ids } }, select:{ id:true,name:true,marketplace:true,adProduct:true,targetingType:true,dailyBudget:true } })
const r = await previewSovRule({
  actions:[{ type:'sov', control:'manual', campaigns:camps.map(c=>({id:c.id,name:c.name,marketplace:c.marketplace,adProduct:c.adProduct,targetingType:c.targetingType,dailyBudget:c.dailyBudget})), bidFloor:0.05, bidCeiling:null, schedule:{frequency:'daily',time:'00:00',timezone:'Europe/Rome'} }],
  conditions:[{ match:'all', lookback:'Last 30 Days', exclude:'Last 2 Days', conditions:[{metric:'Share of Voice',op:'lt',value:'100'}], action:{op:'set',value:'0.75'} }],
  scopeMarketplace:null,
})
console.log(`campaigns: ${camps.map(c=>c.name).join(' · ')}`)
console.log(`\n### AFTER THE FIX`)
console.log(`  matched=${r.matched}  rows=${r.rows.length}  → dropped: ${r.matched-r.rows.length} (must be 0)`)
console.log(`  suppressedMatched=${r.suppressedMatched} unflagged=${r.suppressedUnflaggedMatched} campaignSuppressed=${r.campaignSuppressedMatched}`)
const refused = r.rows.filter(x=>x.refused)
console.log(`  refusal rows rendered: ${refused.length}`)
for (const x of refused.slice(0,3)) console.log(`    ${x.marketplace} "${x.keyword}" €${x.currentEur.toFixed(2)} → ${x.refused?.slice(0,90)}…`)
console.log(`\n  a bid row for contrast:`)
for (const x of r.rows.filter(x=>!x.refused).slice(0,2)) console.log(`    ${x.marketplace} "${x.keyword}" €${x.currentEur.toFixed(2)} → €${x.proposedEur.toFixed(2)}`)
await prisma.$disconnect()
