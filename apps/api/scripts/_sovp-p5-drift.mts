import '../src/env.js'
const { default: prisma } = await import('../src/db.js')
const { previewSovRule } = await import('../src/services/advertising/ads-sov-preview.service.js')
const names = ['DE_Exact_3_Keywords','GALE EXACT DE','DE_Phrase_3_Keywords']
const camps = await prisma.campaign.findMany({ where: { name: { in: names } }, select: { id:true,name:true,marketplace:true,adProduct:true,targetingType:true,dailyBudget:true } })
const draft = {
  actions: [{ type:'sov', control:'manual', campaigns: camps.map(c=>({ id:c.id,name:c.name,marketplace:c.marketplace,adProduct:c.adProduct,targetingType:c.targetingType,dailyBudget:c.dailyBudget })), bidFloor:0.05, bidCeiling:null, schedule:{frequency:'daily',time:'00:00',timezone:'Europe/Rome'} }],
  conditions: [{ match:'all', lookback:'Last 30 Days', exclude:'Last 2 Days', conditions:[{metric:'Share of Voice',op:'lt',value:'100'}], action:{op:'set',value:'0.75'} }],
  scopeMarketplace: null as string|null,
}
const r = await previewSovRule(draft)
console.log(`campaigns: ${camps.map(c=>c.name).join(' · ')}`)
console.log(`\n🔴 THE DRIFT:`)
console.log(`   matched = ${r.matched}   rows rendered = ${r.rows.length}   → ${r.matched - r.rows.length} row(s) SILENTLY DROPPED`)
console.log(`   suppressedMatched=${r.suppressedMatched} unflagged=${r.suppressedUnflaggedMatched} campaignSuppressed=${r.campaignSuppressedMatched}`)
console.log(`\n   the warning my shipped preview renders would say:`)
if (r.suppressedMatched > 0) console.log(`     "⚠ ${r.suppressedMatched} of the ${r.matched} are deliberately suppressed. This rule WOULD RAISE them above €0.05 and switch delivery back on"`)
else console.log(`     (no warning — suppressedMatched is 0, because the suppressed rows never reach the row loop)`)
console.log(`\n   what the engine actually does now: bid_apply returns skipped=suppressed_flag|suppressed_by_bid|campaign_suppressed BEFORE the dryRun return.`)
await prisma.$disconnect()
