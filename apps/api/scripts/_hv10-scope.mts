/** HV.10 — parseMarketScope, the whole contract. READ-ONLY, no DB. */
import '../src/env.js'
const { parseMarketScope, marketWhere } = await import('../src/services/advertising/keyword-harvest.service.js')
let fail=0
const ck=(l:string,ok:boolean,d='')=>{ if(!ok)fail++; console.log(`  ${ok?'✅':'🔴'} ${l.padEnd(56)} ${d}`) }
const j=(x:unknown)=>JSON.stringify(x)
ck('"all" → all',            j(parseMarketScope('all'))===j({kind:'all'}))
ck('"" → all (absent)',      j(parseMarketScope(''))===j({kind:'all'}))
ck('"IT" → list [IT]',       j(parseMarketScope('IT'))===j({kind:'list',codes:['IT']}))
ck('"IT,DE" → list [IT,DE]', j(parseMarketScope('IT,DE'))===j({kind:'list',codes:['IT','DE']}))
ck('lowercase + spaces',     j(parseMarketScope(' it , de '))===j({kind:'list',codes:['IT','DE']}))
ck('duplicates collapse',    j(parseMarketScope('IT,IT,DE'))===j({kind:'list',codes:['IT','DE']}))
ck('unknown code dropped',   j(parseMarketScope('IT,ZZ'))===j({kind:'list',codes:['IT']}))
ck('🔴 all-unknown → all, never empty', j(parseMarketScope('ZZ,QQ'))===j({kind:'all'}))
ck('marketWhere("all") is unconstrained', j(marketWhere('all'))===j({}))
ck('marketWhere single → equality', j(marketWhere('DE'))===j({marketplace:'DE'}))
ck('marketWhere list → IN',   j(marketWhere('IT,DE'))===j({marketplace:{in:['IT','DE']}}))
console.log(`\n  ${fail===0?'✅ all pass':`🔴 ${fail} failed`}`)
process.exit(fail?1:0)
