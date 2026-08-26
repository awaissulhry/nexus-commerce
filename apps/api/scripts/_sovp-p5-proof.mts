import '../src/env.js'
const { default: prisma } = await import('../src/db.js')
const { KT6_SUPPRESSION_CENTS } = await import('../src/services/advertising/kt6-bid-action.js')
console.log(`suppression threshold: <=${KT6_SUPPRESSION_CENTS}c`)
const flagged = await prisma.adTarget.count({ where:{ isNegative:false, kind:'KEYWORD', suppressedFromBidCents:{ not:null } } })
const lowBid  = await prisma.adTarget.count({ where:{ isNegative:false, kind:'KEYWORD', status:'ENABLED', bidCents:{ lte:KT6_SUPPRESSION_CENTS } } })
const suppCamp= await prisma.adTarget.count({ where:{ isNegative:false, kind:'KEYWORD', status:'ENABLED', adGroup:{ campaign:{ bidsSuppressedAt:{ not:null } } } } })
console.log(`\n### THE SUPPRESSED POPULATION RIGHT NOW (enabled keyword targets)`)
console.log(`  carries suppressedFromBidCents : ${flagged}`)
console.log(`  bid <= ${KT6_SUPPRESSION_CENTS}c, unflagged        : ${lowBid}`)
console.log(`  in a bid-suppressed campaign   : ${suppCamp}`)

// Now prove the handler refuses one, and that my parse drops it.
const victim = await prisma.adTarget.findFirst({ where:{ isNegative:false, kind:'KEYWORD', status:'ENABLED', bidCents:{ lte:KT6_SUPPRESSION_CENTS } }, select:{ id:true, expressionValue:true, bidCents:true } })
if (!victim) { console.log('\n(no suppressed target right now — the state machine turns over hourly)'); await prisma.$disconnect(); process.exit(0) }
const { ACTION_HANDLERS } = await import('../src/services/automation-rule.service.js')
await import('../src/services/advertising/automation-action-handlers.js')
const h = ACTION_HANDLERS['bid_apply'] as (a:unknown,c:unknown,m:unknown)=>Promise<{ok:boolean;output?:Record<string,unknown>;error?:string}>
const res = await h({ type:'bid_apply', op:'set', value:0.75, minEur:0.05, maxEur:null, adTargetId:victim.id }, { adTarget:{ id:victim.id } }, { dryRun:true, ruleId:'proof' })
console.log(`\n### THE HANDLER, dryRun, on "${victim.expressionValue}" (${victim.bidCents}c)`)
console.log(`  ${JSON.stringify(res.output)}`)
const out = res.output ?? {}
console.log(`\n### MY SHIPPED PARSE`)
console.log(`  \`if (typeof out.skipped === 'string') continue\`  → skipped=${JSON.stringify(out.skipped)}  → row DROPPED: ${typeof out.skipped === 'string'}`)
console.log(`  wouldChange present? ${out.wouldChange !== undefined}  → nothing to render even if kept`)
console.log(`\n🔴 CONSEQUENCE: the row vanishes from the preview, \`matched\` still counts it, and my`)
console.log(`   suppressedMatched (computed from rows[]) can NEVER be > 0 again — so the warning is dead code.`)
await prisma.$disconnect()
