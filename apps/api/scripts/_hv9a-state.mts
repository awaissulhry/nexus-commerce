/** HV.9a — the FULL state after the interrupted-response write. READ-ONLY. */
import '../src/env.js'
const { default: prisma } = await import('../src/db.js')
const since = new Date(Date.now() - 45*60_000)
console.log('\n═══ every AdTarget created in the last 45 min ═══')
const t = await prisma.adTarget.findMany({ where:{ createdAt:{ gte: since } },
  select:{ id:true, expressionValue:true, expressionType:true, isNegative:true, negativeLevel:true, bidCents:true, externalTargetId:true, createdAt:true,
           adGroup:{ select:{ name:true, campaign:{ select:{ name:true } } } } }, orderBy:{ createdAt:'asc' } })
for (const x of t) console.log(`  ${x.createdAt.toISOString().slice(11,19)} ${x.isNegative?'NEG':'POS'} "${x.expressionValue}" ${x.expressionType} lvl=${x.negativeLevel??'—'} bid=${x.bidCents}c ext=${x.externalTargetId ?? '🔴 NULL'} ${x.adGroup?.campaign?.name} › ${x.adGroup?.name}`)
console.log(`  → ${t.length} rows (${t.filter(x=>x.isNegative).length} negative)`)

console.log('\n═══ create_keyword / create_negative_keyword audit rows, last 45 min ═══')
const l = await prisma.advertisingActionLog.findMany({
  where:{ createdAt:{ gte: since }, actionType:{ in:['create_keyword','create_negative_keyword'] } },
  select:{ actionType:true, userId:true, entityId:true, createdAt:true, payloadAfter:true, evidence:true }, orderBy:{ createdAt:'asc' } })
if (!l.length) console.log('  🔴 (none)')
for (const x of l) {
  console.log(`  ${x.createdAt.toISOString().slice(11,19)} ${x.actionType} by ${x.userId}`)
  console.log(`      after:    ${JSON.stringify(x.payloadAfter)}`)
  console.log(`      evidence: ${JSON.stringify(x.evidence)}`)
}

console.log('\n═══ any negative for this term, anywhere, ever ═══')
const n = await prisma.adTarget.findMany({ where:{ expressionValue:'motorradjacke 4xl', isNegative:true },
  select:{ expressionType:true, negativeLevel:true, externalTargetId:true, createdAt:true, adGroup:{ select:{ name:true, campaign:{ select:{ name:true } } } } } })
if (!n.length) console.log('  🔴 NONE — the negative half did not create a local row')
for (const x of n) console.log(`  ${x.createdAt.toISOString().slice(0,19)} ${x.expressionType} lvl=${x.negativeLevel} ext=${x.externalTargetId ?? 'NULL'} ${x.adGroup?.campaign?.name} › ${x.adGroup?.name}`)
await prisma.$disconnect()
