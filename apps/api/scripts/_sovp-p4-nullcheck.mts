import '../src/env.js'
const { default: prisma } = await import('../src/db.js')
const { buildSovBidContexts } = await import('../src/jobs/advertising-rule-evaluator.job.js')
const ctxs = await buildSovBidContexts() as any[]
console.log(`contexts: ${ctxs.length}`)
const nullSov = ctxs.filter((c) => c.adTarget.sovPct == null).length
const nullConc = ctxs.filter((c) => c.adTarget.topSharePct == null)
console.log(`sovPct null           : ${nullSov}  (starters 1 & 2 gate on Share of Voice)`)
console.log(`topSharePct null      : ${nullConc.length}  (starter 3 gates on Campaign Concentration)`)
// starter 3: Campaign Concentration < 60% AND Spend >= €5
const exposed = nullConc.filter((c) => (c.adTarget.spendCents ?? 0) >= 500)
console.log(`🔴 null concentration AND spend >= EUR5 (starter 3's exposure): ${exposed.length}`)
for (const c of exposed.slice(0, 5)) console.log(`   ${c.marketplace} target=${c.adTarget.id} spend=EUR${((c.adTarget.spendCents ?? 0)/100).toFixed(2)} sov=${(c.adTarget.sovPct*100).toFixed(2)}%`)
// and how does the engine's comparator actually treat null?
const { evaluateConditions } = await import('../src/services/automation/conditions-tree.js')
const probe = (v: number | null) => evaluateConditions([{ field: 'adTarget.topSharePct', op: 'lt', value: 0.6 }] as never, { adTarget: { topSharePct: v } } as never)
console.log(`\nengine comparator: null lt 0.6  -> ${probe(null)}   (true = the null-matching hazard is REAL here)`)
console.log(`engine comparator: 0.5  lt 0.6  -> ${probe(0.5)}`)
console.log(`engine comparator: 0.9  lt 0.6  -> ${probe(0.9)}`)
await prisma.$disconnect()
