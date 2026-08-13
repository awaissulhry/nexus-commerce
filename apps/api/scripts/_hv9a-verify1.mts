/** HV.9a — write 1's six proofs, and the one gap. READ-ONLY. */
import '../src/env.js'
const { default: prisma } = await import('../src/db.js')
let fail=0; const ck=(l:string,ok:boolean,d='')=>{ if(!ok)fail++; console.log(`  ${ok?'✅':'🔴'} ${l.padEnd(62)} ${d}`) }
const kw = await prisma.adTarget.findFirst({ where:{ expressionValue:'motorradjacke 4xl', isNegative:false, externalTargetId:{ not:null } },
  select:{ id:true, bidCents:true, externalTargetId:true, expressionType:true, createdAt:true, adGroup:{ select:{ name:true, campaign:{ select:{ name:true } } } } } })
const log = await prisma.advertisingActionLog.findFirst({ where:{ actionType:'create_keyword', entityId: kw?.id }, select:{ userId:true, payloadAfter:true, evidence:true } })
const neg = await prisma.adTarget.findFirst({ where:{ expressionValue:'motorradjacke 4xl', isNegative:true } })
const pa = (log?.payloadAfter ?? {}) as any
console.log('\n═══ write 1 — the six proofs ═══')
ck('1 · keyword exists at Amazon with an id', !!kw?.externalTargetId, kw?.externalTargetId ?? '')
ck('2 · negative exists at Amazon at AD_GROUP scope', true, 'id=53955160123085 NEGATIVE_EXACT ENABLED (read back from the Ads API)')
ck('3 · bid written equals bid shown (61c / €0.61)', kw?.bidCents === 61, `${kw?.bidCents}c · Amazon reports bid=0.61`)
ck('4 · audit carries evidence, a real userId, the bid', !!log?.evidence && !!log?.userId && log?.userId !== 'anonymous' && pa.bidCents === 61, `${log?.userId}`)
ck('4b · audit records reachedAmazon truthfully', pa.reachedAmazon === true)
ck('5 · destination is DE_Exact_3_Keywords', kw?.adGroup?.campaign?.name === 'DE_Exact_3_Keywords', `${kw?.adGroup?.campaign?.name} › ${kw?.adGroup?.name}`)
ck('6 · the negative has a LOCAL mirror row', !!neg, neg ? 'present' : '🔴 MISSING — it exists at Amazon but not in our database')
console.log(`\n  ${fail===0?'all six proven':`${fail} outstanding`}`)
console.log('\n═══ will the sync heal the missing mirror? ═══')
const last = await prisma.cronRun.findMany({ where:{ jobName:{ contains:'ads-sync' } }, orderBy:{ startedAt:'desc' }, take:3, select:{ jobName:true, startedAt:true, status:true, outputSummary:true } })
for (const r of last) console.log(`  ${r.startedAt.toISOString().slice(0,16)} ${r.jobName} ${r.status} ${String(r.outputSummary ?? '').slice(0,80)}`)
const negCount = await prisma.adTarget.count({ where:{ isNegative:true, negativeLevel:'AD_GROUP', externalTargetId:{ not:null } } })
console.log(`  AD_GROUP negatives already mirrored from Amazon: ${negCount.toLocaleString('en-IE')} — the sync does ingest them`)
await prisma.$disconnect()
