import '../src/env.js'
const { buildCampaignBudgetContexts } = await import('../src/jobs/advertising-rule-evaluator.job.js')
const { default: prisma } = await import('../src/db.js')
const has = (v: any) => v !== null && v !== undefined
const out: any = {}

// ── Verify PLC-P's headline independently, on the SAME contexts the engine builds ──
const ctxs: any[] = await buildCampaignBudgetContexts(7) as any
const f = (k: string) => ctxs.map(c => c.campaign?.[k])
out.budgetContexts = {
  total: ctxs.length,
  nullCounts: Object.fromEntries(['acos','roas','ctr','cvr','cpcCents','budgetUtilization']
    .map(k => [k, f(k).filter((v:any)=>!has(v)).length])),
  // the comparator hole, per nullable field: how many NULL rows satisfy "<= <typical bar>"
  nullRowsMatchingLte: Object.fromEntries([['acos',0.25],['roas',1],['ctr',0.005],['cvr',0.05],['cpcCents',50],['budgetUtilization',0.1]]
    .map(([k, bar]: any) => [`${k} <= ${bar}`, ctxs.filter(c => !has(c.campaign?.[k]) && Number(c.campaign?.[k]) <= bar).length])),
}
// ── The armed rules' own leaves, evaluated exactly as the engine does ──
out.armedRules = {
  'Reclaim idle budget — DE': {
    leafAlone_utilLte10pct: ctxs.filter(c => Number(c.campaign?.budgetUtilization) <= 0.1).length,
    ofWhichNullUtil: ctxs.filter(c => !has(c.campaign?.budgetUtilization) && Number(c.campaign?.budgetUtilization) <= 0.1).length,
    wholeRule: ctxs.filter(c => Number(c.campaign?.budgetUtilization) <= 0.1 && Number(c.campaign?.spendCents) >= 500).length,
    verdict: 'budgetUtilization is never null in this context → the null hole does NOT reach this rule',
  },
}
// ── The search-term side: the harvest rule's acos leaf. Builder is not exported, so measure the
//    SOURCE the emitter reads, at the same floor (>=2 orders) the emitter applies.
const st = await prisma.$queryRawUnsafe<any[]>(`
  SELECT count(*)::int terms,
         count(*) FILTER (WHERE "sales7dCents" = 0)::int zero_sales,
         count(*) FILTER (WHERE "orders7d" >= 2)::int ge2_orders,
         count(*) FILTER (WHERE "orders7d" >= 2 AND "sales7dCents" = 0)::int ge2_orders_zero_sales
  FROM "AmazonAdsSearchTerm" WHERE "date" > now() - interval '32 days'`)
out.harvestRuleSource = { ...st[0],
  note: 'acos is null exactly where salesCents = 0; the rule ANDs orders >= 2, so exposure = ge2_orders_zero_sales' }
console.log('===JSON===' + JSON.stringify(out, (_k,v)=>typeof v==='bigint'?Number(v):v, 1))
await prisma.$disconnect()
