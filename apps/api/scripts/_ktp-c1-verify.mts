import '../src/env.js'
const { buildCampaignBudgetContexts, buildSovBidContexts } = await import('../src/jobs/advertising-rule-evaluator.job.js')
const { default: prisma } = await import('../src/db.js')
const has = (o: any, k: string) => Object.prototype.hasOwnProperty.call(o, k)
const out: any = {}

const b: any[] = await buildCampaignBudgetContexts(7) as any
out.budget = {
  contexts: b.length,
  acos_key_present: b.filter(c => has(c.campaign,'acos')).length,
  acos_key_absent:  b.filter(c => !has(c.campaign,'acos')).length,
  // the defect, re-run: how many now match "ACoS <= 25%"?
  matches_acos_lte_25: b.filter(c => Number(c.campaign.acos) <= 0.25).length,
  // the ARMED rule's own leaf — must be unchanged
  armed_utilLte10_and_spendGte5: b.filter(c => Number(c.campaign.budgetUtilization) <= 0.1 && Number(c.campaign.spendCents) >= 500).length,
  util_key_absent: b.filter(c => !has(c.campaign,'budgetUtilization')).length,
}
const s: any[] = await buildSovBidContexts() as any
out.sov = {
  contexts: s.length,
  concentration_absent: s.filter(c => !has(c.adTarget,'topSharePct')).length,
  matches_conc_lt_60: s.filter(c => Number(c.adTarget.topSharePct) < 0.6).length,
  perf_acos_absent: s.filter(c => !has(c.adTarget,'acos')).length,
  matches_acos_lte_20: s.filter(c => Number(c.adTarget.acos) <= 0.2).length,
}
console.log('===JSON===' + JSON.stringify(out, (_k,v)=>typeof v==='bigint'?Number(v):v, 1))
await prisma.$disconnect()
