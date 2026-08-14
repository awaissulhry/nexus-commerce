/** WH — prove the cap counter fix, both clauses, on prod data. READ-ONLY. */
import '../src/env.js'
const { default: prisma } = await import('../src/db.js')
const int = (n:number)=>n.toLocaleString('en-IE')
const since = new Date(Date.now() - 60*86400_000)
const [total, nullErr, cap, brokenClause, nullSafe] = await Promise.all([
  prisma.automationRuleExecution.count({ where: { startedAt: { gte: since } } }),
  prisma.automationRuleExecution.count({ where: { startedAt: { gte: since }, errorMessage: null } }),
  prisma.automationRuleExecution.count({ where: { startedAt: { gte: since }, errorMessage: 'DAILY_CAP_EXCEEDED' } }),
  prisma.automationRuleExecution.count({ where: { startedAt: { gte: since }, NOT: { errorMessage: 'DAILY_CAP_EXCEEDED' } } }),
  prisma.automationRuleExecution.count({ where: { startedAt: { gte: since }, OR: [{ errorMessage: null }, { errorMessage: { not: 'DAILY_CAP_EXCEEDED' } }] } }),
])
console.log(`executions in 60d            ${int(total)}`)
console.log(`  errorMessage IS NULL       ${int(nullErr)}`)
console.log(`  DAILY_CAP_EXCEEDED         ${int(cap)}  (${((cap/total)*100).toFixed(1)}% of the table)`)
console.log(`  other errors               ${int(total - nullErr - cap)}`)
console.log(`\nOLD clause  NOT(errorMessage='DAILY_CAP_EXCEEDED')   → ${int(brokenClause)}`)
console.log(`NEW clause  OR[null, not 'DAILY_CAP_EXCEEDED']        → ${int(nullSafe)}`)
console.log(`\n🔴 blind spot closed: ${int(nullSafe - brokenClause)} rows the cap could not see`)
let f = 0
const ck = (l:string,c:boolean,d='')=>{ if(!c) f++; console.log(`  ${c?'✓':'🔴'} ${l}${d?` — ${d}`:''}`) }
ck('the new clause counts every non-cap row', nullSafe === total - cap, `${int(nullSafe)} = ${int(total)} - ${int(cap)}`)
ck('🔴 the new clause EXCLUDES cap refusals — it must not count them', nullSafe < total, `${int(total-nullSafe)} excluded`)
ck('the old clause was blind to every null-error row', brokenClause === total - cap - nullErr, `old ${int(brokenClause)}`)
ck('an assertion over an empty table would FAIL', total > 0)
console.log(f===0 ? '\n✓ all assertions passed' : `\n🔴 ${f} FAILED`)
await prisma.$disconnect(); process.exit(f===0?0:1)
