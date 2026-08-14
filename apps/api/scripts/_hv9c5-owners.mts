/** HV.9c.5 — who holds each of the 9 Amazon ids? READ-ONLY. */
import '../src/env.js'
const { default: prisma } = await import('../src/db.js')
const IDS=['16026030732543','128430480348864','252943870004724','169513143345169','216419338483049','126731108917969','204988683848148','156132292838069','45785702917260']
for (const ext of IDS) {
  const rows = await prisma.adTarget.findMany({ where:{ externalTargetId: ext },
    select:{ id:true, expressionValue:true, bidCents:true, status:true, createdAt:true, adGroup:{ select:{ name:true, campaign:{ select:{ name:true } } } } } })
  const inCohort = await prisma.advertisingActionLog.findFirst({ where:{ actionType:'create_keyword', userId:'automation:auto-harvest', entityId:{ in: rows.map(r=>r.id) } }, select:{ entityId:true } })
  const pushed = await prisma.advertisingActionLog.findFirst({ where:{ actionType:'push_keyword', entityId:{ in: rows.map(r=>r.id) } }, select:{ entityId:true } })
  const r=rows[0]
  console.log(`  ${ext.padEnd(16)} rows=${rows.length} "${String(r?.expressionValue).slice(0,32).padEnd(34)}" bid=${r?.bidCents}c ${r?.status} created=${r?.createdAt.toISOString().slice(0,10)} ${inCohort?'harvest-cohort':'NOT harvest'} ${pushed?'· pushed today':''}`)
}
console.log('\n  → the row holding each id must NOT be archived; every other row in its group must be.')
await prisma.$disconnect()
