import '../src/env.js'
const { default: prisma } = await import('../src/db.js')
const pct=(n:number)=>(n*100).toFixed(1)+'%'

// 1 · what the BID engine can actually select (KEYWORD_HIGH_ACOS emitter)
const src = (await import('node:fs')).readFileSync('src/jobs/advertising-rule-evaluator.job.ts','utf8')
const i = src.indexOf('async function buildHighAcosKeywordContexts')
const seg = src.slice(i, i+1800)
const where = seg.match(/where:\s*\{[^}]*\}/g)?.slice(0,3) ?? []
console.log('### 1 · the bid emitter\'s selection')
for (const w of where) console.log('   ', w.replace(/\s+/g,' ').slice(0,150))

// 2 · population the client preview lists vs what a bid rule can act on
const all = await prisma.adTarget.count({ where: { isNegative: false } })
const kw  = await prisma.adTarget.count({ where: { isNegative: false, kind: 'KEYWORD' } })
const kwEn= await prisma.adTarget.count({ where: { isNegative: false, kind: 'KEYWORD', status: 'ENABLED' } })
console.log(`\n### 2 · POPULATION`)
console.log(`   /advertising/targets lists         : ${all} positive targets`)
console.log(`   the builder asks limit=1500, no orderBy → ${all>1500?`${all-1500} (${pct((all-1500)/all)}) unreachable`:'all fit'}`)
console.log(`   KEYWORD targets                    : ${kw} (${pct(kw/all)})`)
console.log(`   ENABLED KEYWORD                    : ${kwEn} (${pct(kwEn/all)})`)

// 3 · the computed ops — what the client CANNOT compute
console.log(`\n### 3 · THE THEN ACTIONS`)
const arith=['set','incPct','decPct','incAbs','decAbs']
const computed=['targetAcos','setCpc','revPerClick','curBidTargetAcos']
const status=['pauseTarget','enableTarget']
console.log(`   the builder offers ${arith.length+computed.length+status.length} actions; the client preview's apply() handles ${arith.length}`)
console.log(`   computed (engine reads measured perf): ${computed.join(', ')}`)
console.log(`   status verbs (no bid at all)         : ${status.join(', ')}`)
console.log(`   → for all ${computed.length+status.length}, apply(cur) falls through to \`: cur\`, so proposed === current on EVERY row`)

// 4 · would the engine have produced a number? measure the signal the computed ops need
const { ruleWindowBounds } = await import('../src/services/advertising/ads-rule-window-bounds.js').catch(()=>({ruleWindowBounds:null as never}))
const since=new Date(Date.now()-16*864e5), until=new Date(Date.now()-2*864e5)
const perf = await prisma.amazonAdsDailyPerformance.groupBy({ by:['localEntityId'], where:{ entityType:'AD_TARGET', date:{gte:since,lte:until} }, _sum:{ costMicros:true, clicks:true, sales7dCents:true } })
const withClicks = perf.filter(p=>(p._sum.clicks??0)>0)
const withSales  = withClicks.filter(p=>(p._sum.sales7dCents??0)>0)
console.log(`\n### 4 · WHAT THE ENGINE WOULD HAVE SAID (14 settled days)`)
console.log(`   targets with performance rows : ${perf.length}`)
console.log(`   with clicks (setCpc computable): ${withClicks.length}`)
console.log(`   with sales (ratio ops computable): ${withSales.length}`)
console.log(`   → setCpc/targetAcos would REFUSE, named, on ${withClicks.length-withSales.length} of ${withClicks.length} clicked targets ("spend but no attributed sales")`)

// 5 · how many bid rules exist
const rules = await prisma.automationRule.findMany({ where:{ domain:'advertising' }, select:{ name:true, actions:true } })
const bid = rules.filter(r=>(r.actions as Array<{type?:string}>).some(a=>a?.type==='bid'))
console.log(`\n### 5 · EXPOSURE TODAY`)
console.log(`   advertising rules: ${rules.length} · bid rules: ${bid.length}`)
console.log(`   → the defect is in the AUTHORING surface; it misleads whoever writes the next bid rule`)
await prisma.$disconnect()
