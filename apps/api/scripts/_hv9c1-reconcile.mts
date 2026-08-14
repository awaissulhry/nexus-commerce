/** HV.9c.1 §3.7 — the 6-vs-3 reconciliation, from the audit rows. READ-ONLY. */
import '../src/env.js'
const { default: prisma } = await import('../src/db.js')
const logs = await prisma.advertisingActionLog.findMany({
  where:{ actionType:'push_keyword' }, orderBy:{ createdAt:'asc' },
  select:{ entityId:true, createdAt:true, payloadAfter:true } })
console.log(`\n═══ push_keyword audit rows: ${logs.length} ═══`)
const byExt=new Map<string,{first:string;n:number;ts:string}>()
for (const l of logs) {
  const ext=String((l.payloadAfter as any)?.externalId ?? '')
  const e=byExt.get(ext); if(e){e.n++} else byExt.set(ext,{first:l.entityId,n:1,ts:l.createdAt.toISOString().slice(11,19)})
}
console.log(`  distinct externalIds across those pushes: ${byExt.size}`)
for (const [ext,v] of byExt) {
  const owner = await prisma.adTarget.findFirst({ where:{ externalTargetId: ext }, select:{ id:true, expressionValue:true } })
  console.log(`    ${ext}  pushes=${String(v.n).padStart(2)}  firstAt=${v.ts}  firstRow=${v.first.slice(0,12)}…  ownerNow=${owner? (owner.id===v.first?'THE FIRST PUSHER ✅':`another row 🔴 ${owner.id.slice(0,12)}…`) : '🔴 NOBODY — id is unattributed'}`)
}
console.log(`\n═══ did the repair strip an id from a row that had NOT been pushed? ═══`)
const pushedIds=new Set(logs.map(l=>l.entityId))
const stripped = [...byExt.values()].map(v=>v.first)
const cohortNull = await prisma.$queryRaw<Array<{id:string;kw:string}>>`
  WITH f AS (SELECT DISTINCT ON ("entityId") "entityId" FROM "AdvertisingActionLog"
             WHERE "actionType"='create_keyword' AND "userId"='automation:auto-harvest' ORDER BY "entityId","createdAt" ASC)
  SELECT t.id, t."expressionValue" AS kw FROM "AdTarget" t JOIN f ON f."entityId"=t.id
  WHERE t."isNegative"=false AND t."externalTargetId" IS NULL`
const nulledNeverPushed = cohortNull.filter(r=>!pushedIds.has(r.id))
console.log(`  cohort rows now NULL that were never pushed: ${nulledNeverPushed.length} (expected: the original local-only backlog)`)
console.log(`  cohort rows now NULL that WERE pushed:      ${cohortNull.length-nulledNeverPushed.length} (the duplicates the repair cleared)`)
console.log(`\n═══ the 6 ids the pushes produced, and whether each is still attributed ═══`)
const attributed = (await prisma.adTarget.findMany({ where:{ externalTargetId:{ in:[...byExt.keys()] } }, select:{ externalTargetId:true } })).map(r=>r.externalTargetId)
console.log(`  ${attributed.length} of ${byExt.size} still attributed to exactly one row`)
await prisma.$disconnect()
