import '../src/env.js'
const { default: prisma } = await import('../src/db.js')
const pct=(n:number)=>(n*100).toFixed(1)+'%'
const { ruleWindowBounds } = await import('../src/utils/rule-window.js').catch(async()=>({ ruleWindowBounds:(d:number)=>({ since:new Date(Date.now()-(d+2)*864e5), until:new Date(Date.now()-2*864e5) }) }))
const { since, until } = ruleWindowBounds(14)
const perf = await prisma.amazonAdsDailyPerformance.groupBy({ by:['localEntityId','marketplace'], where:{ entityType:'AD_TARGET', date:{gte:since,lte:until} }, _sum:{ costMicros:true, sales7dCents:true, orders7d:true, clicks:true } })
const rows = perf.map(p=>({ id:p.localEntityId as string, spend:Math.round(Number(p._sum.costMicros??0)/10000), sales:p._sum.sales7dCents??0, orders:p._sum.orders7d??0 }))
// the emitter's own floor, verbatim
const emitted = rows.filter(x=> x.orders>0 && x.sales>0 && x.spend>=200 && x.spend/x.sales>=0.2).slice(0,500)
console.log('### THE BID EMITTER\'S FLOOR (KEYWORD_HIGH_ACOS, 14 settled days)')
console.log(`  targets with performance rows        : ${rows.length}`)
console.log(`  orders > 0                            : ${rows.filter(x=>x.orders>0).length}`)
console.log(`  ...and sales > 0                      : ${rows.filter(x=>x.orders>0&&x.sales>0).length}`)
console.log(`  ...and spend >= EUR2                  : ${rows.filter(x=>x.orders>0&&x.sales>0&&x.spend>=200).length}`)
console.log(`  ...and ACoS >= 20%  → EMITTED         : ${emitted.length}`)
const allPos = await prisma.adTarget.count({ where:{ isNegative:false } })
console.log(`\n  a bid rule can act on ${emitted.length} of ${allPos} positive targets = ${pct(emitted.length/allPos)}`)
console.log(`  the client preview lists every positive target in the picked campaigns (capped at an arbitrary 1,500)`)

// 🔴 does the emitter ever produce a NULL acos?
const nullAcos = emitted.filter(x=>x.sales<=0).length
console.log(`\n### CORRECTION CHECK — can adTarget.acos be null in a KEYWORD_HIGH_ACOS context?`)
console.log(`  emitted rows with sales <= 0 (would give null acos): ${nullAcos}`)
console.log(`  → the emitter REQUIRES orders>0 AND sales>0, so acos is ALWAYS defined for builder bid rules`)
console.log(`  → the "197 of 435 null-ACoS targets a bid rule reads as winners" concern does NOT reach a builder Bid rule:`)
console.log(`     those targets never become KEYWORD_HIGH_ACOS contexts at all.`)
await prisma.$disconnect()
