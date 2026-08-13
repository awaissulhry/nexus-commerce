/** HV.9a — why did write 2 report failed? READ-ONLY. */
import '../src/env.js'
const { default: prisma } = await import('../src/db.js')
const T='veste moto homme homologué'
const rows = await prisma.adTarget.findMany({ where:{ expressionValue:T },
  select:{ id:true, expressionType:true, isNegative:true, negativeLevel:true, externalTargetId:true, createdAt:true,
           adGroup:{ select:{ name:true, externalAdGroupId:true, campaign:{ select:{ name:true, externalCampaignId:true } } } } }, orderBy:{ createdAt:'asc' } })
console.log(`\n═══ all rows for "${T}" — ${rows.length} ═══`)
for (const r of rows) console.log(`  ${r.createdAt.toISOString().slice(0,19)} ${r.isNegative?'NEG':'POS'} ${String(r.expressionType).padEnd(16)} lvl=${r.negativeLevel ?? '—'} ext=${r.externalTargetId ?? '🔴 NULL'} ${r.adGroup?.campaign?.name} › ${r.adGroup?.name} (ag ext=${r.adGroup?.externalAdGroupId})`)
const target = rows.find(r=>r.isNegative && r.negativeLevel==='AD_GROUP' && r.adGroup?.externalAdGroupId==='486569644763929')
console.log(`\n  an AD_GROUP negative in the TARGET ad group already existed before this write? ${target ? `YES — created ${target.createdAt.toISOString().slice(0,19)}, ext=${target.externalTargetId ?? 'NULL'}` : 'no'}`)
const recent = rows.filter(r=>r.createdAt > new Date(Date.now()-15*60_000))
console.log(`  rows created in the last 15 min: ${recent.length}`)
await prisma.$disconnect()
