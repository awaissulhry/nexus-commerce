import '../src/env.js'
const job: any = await import('../src/jobs/advertising-rule-evaluator.job.js')
const { default: prisma } = await import('../src/db.js')
const out: any = {}

// ── Rule 2: "Reclaim idle budget — DE" → campaign.budgetUtilization lte 0.1 AND spendCents gte 500
if (typeof job.buildCampaignBudgetContexts === 'function') {
  const ctxs: any[] = await job.buildCampaignBudgetContexts(7)
  const has = (v: any) => v !== null && v !== undefined
  out.budgetRule = {
    contexts: ctxs.length,
    utilNull: ctxs.filter(c => !has(c.campaign?.budgetUtilization)).length,
    // the leaf ALONE, evaluated the way the engine does it
    matchUtilLeafAlone: ctxs.filter(c => Number(c.campaign?.budgetUtilization) <= 0.1).length,
    matchUtilLeafAlone_butNull: ctxs.filter(c => !has(c.campaign?.budgetUtilization) && Number(c.campaign?.budgetUtilization) <= 0.1).length,
    // the WHOLE rule, both leaves ANDed — what actually fires
    matchWholeRule: ctxs.filter(c => Number(c.campaign?.budgetUtilization) <= 0.1 && Number(c.campaign?.spendCents) >= 500).length,
    matchWholeRule_onNullUtil: ctxs.filter(c => !has(c.campaign?.budgetUtilization) && Number(c.campaign?.budgetUtilization) <= 0.1 && Number(c.campaign?.spendCents) >= 500).length,
    sampleNullUtilWithSpend: ctxs.filter(c => !has(c.campaign?.budgetUtilization) && Number(c.campaign?.spendCents) >= 500)
      .slice(0,5).map(c => ({ name: c.campaign?.name, spendCents: c.campaign?.spendCents, util: c.campaign?.budgetUtilization, dailyBudget: c.campaign?.dailyBudget })),
    marketDE: ctxs.filter(c => c.marketplace === 'DE').length,
  }
}
// ── Rule 4: "Harvest proven winners — GALE DE" → searchTerm.orders gte 2 AND searchTerm.acos lte 0.3
if (typeof job.buildSearchTermConvertingContexts === 'function') {
  const ctxs: any[] = await job.buildSearchTermConvertingContexts()
  const has = (v: any) => v !== null && v !== undefined
  out.harvestRule = {
    contexts: ctxs.length,
    acosNull: ctxs.filter(c => !has(c.searchTerm?.acos)).length,
    matchAcosLeafAlone: ctxs.filter(c => Number(c.searchTerm?.acos) <= 0.3).length,
    matchWholeRule: ctxs.filter(c => Number(c.searchTerm?.orders) >= 2 && Number(c.searchTerm?.acos) <= 0.3).length,
    matchWholeRule_onNullAcos: ctxs.filter(c => !has(c.searchTerm?.acos) && Number(c.searchTerm?.orders) >= 2 && Number(c.searchTerm?.acos) <= 0.3).length,
    sampleNullAcosWith2Orders: ctxs.filter(c => !has(c.searchTerm?.acos) && Number(c.searchTerm?.orders) >= 2)
      .slice(0,5).map(c => ({ q: c.searchTerm?.query, orders: c.searchTerm?.orders, sales: c.searchTerm?.salesCents, spend: c.searchTerm?.spendCents })),
  }
}
console.log('===JSON===' + JSON.stringify(out, (_k,v)=>typeof v==='bigint'?Number(v):v, 1))
await prisma.$disconnect()
