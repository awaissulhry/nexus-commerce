/** HV.9a — did write 1 land? READ-ONLY. No writes of any kind. */
import '../src/env.js'
const { default: prisma } = await import('../src/db.js')
const since = new Date(Date.now() - 30*60_000)
console.log('\n═══ AdTargets created in the last 30 minutes ═══')
const t = await prisma.adTarget.findMany({
  where: { createdAt: { gte: since } },
  select: { id:true, expressionValue:true, expressionType:true, isNegative:true, negativeLevel:true, bidCents:true,
            externalTargetId:true, createdAt:true, adGroup:{ select:{ name:true, campaign:{ select:{ name:true, marketplace:true } } } } },
  orderBy: { createdAt:'asc' },
})
if (!t.length) console.log('  (none)')
for (const x of t) console.log(`  ${x.createdAt.toISOString().slice(11,19)} ${x.isNegative?'NEG':'POS'} ${String(x.expressionValue).slice(0,28).padEnd(30)} ${String(x.expressionType).padEnd(16)} lvl=${x.negativeLevel ?? '—'} bid=${x.bidCents}c ext=${x.externalTargetId ?? '🔴 NULL'} ${x.adGroup?.campaign?.name} › ${x.adGroup?.name}`)

console.log('\n═══ AdvertisingActionLog rows in the last 30 minutes ═══')
const l = await prisma.advertisingActionLog.findMany({
  where: { createdAt: { gte: since } },
  select: { id:true, actionType:true, userId:true, entityId:true, createdAt:true, payloadAfter:true, evidence:true },
  orderBy: { createdAt:'asc' },
})
if (!l.length) console.log('  (none)')
for (const x of l) console.log(`  ${x.createdAt.toISOString().slice(11,19)} ${x.actionType.padEnd(24)} ${String(x.userId).padEnd(18)} entity=${x.entityId}\n      after=${JSON.stringify(x.payloadAfter).slice(0,200)}`)

console.log('\n═══ the specific term, all rows ever ═══')
const all = await prisma.adTarget.findMany({
  where: { expressionValue: 'motorradjacke 4xl' },
  select: { id:true, expressionType:true, isNegative:true, negativeLevel:true, bidCents:true, externalTargetId:true, createdAt:true,
            adGroup:{ select:{ name:true, campaign:{ select:{ name:true } } } } },
  orderBy: { createdAt:'asc' },
})
for (const x of all) console.log(`  ${x.createdAt.toISOString().slice(0,19)} ${x.isNegative?'NEG':'POS'} ${String(x.expressionType).padEnd(16)} lvl=${x.negativeLevel ?? '—'} bid=${x.bidCents}c ext=${x.externalTargetId ?? '🔴 NULL'} ${x.adGroup?.campaign?.name} › ${x.adGroup?.name}`)
if (!all.length) console.log('  (no row for this term at all)')
await prisma.$disconnect()
