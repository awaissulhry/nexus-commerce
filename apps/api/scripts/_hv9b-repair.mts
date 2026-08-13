/**
 * HV.9b — repair the attribution my read-back broke. Operator-approved.
 *
 * DRY RUN unless APPLY=1. Nulls `externalTargetId` on every local row that shares an Amazon id
 * with an earlier-pushed row, keeping the row whose `push_keyword` audit came FIRST — the one that
 * actually created the keyword. Nothing is deleted and nothing is sent to Amazon.
 */
import '../src/env.js'
const { default: prisma } = await import('../src/db.js')
const APPLY = process.env.APPLY === '1'

const shared = await prisma.$queryRaw<Array<{ext:string;n:bigint}>>`
  SELECT "externalTargetId" AS ext, COUNT(*)::bigint AS n FROM "AdTarget"
  WHERE "externalTargetId" IS NOT NULL AND "isNegative"=false
  GROUP BY 1 HAVING COUNT(*)>1`
console.log(`\n  Amazon ids shared by >1 local row: ${shared.length}`)
let keep=0, clear=0
const toClear: string[] = []
for (const s of shared) {
  const rows = await prisma.adTarget.findMany({ where:{ externalTargetId: s.ext, isNegative:false },
    select:{ id:true, expressionValue:true, createdAt:true, adGroup:{ select:{ name:true } } } })
  // the row that CREATED it = earliest push_keyword audit among these ids
  const logs = await prisma.advertisingActionLog.findMany({
    where:{ actionType:'push_keyword', entityId:{ in: rows.map(r=>r.id) } },
    orderBy:{ createdAt:'asc' }, select:{ entityId:true, createdAt:true } })
  const owner = logs[0]?.entityId ?? rows.sort((a,b)=>+a.createdAt-+b.createdAt)[0].id
  const losers = rows.filter(r=>r.id!==owner)
  keep++; clear += losers.length; toClear.push(...losers.map(r=>r.id))
  console.log(`  ext=${s.ext} "${String(rows[0]?.expressionValue).slice(0,28)}" — keep 1 (${owner.slice(0,10)}…), clear ${losers.length}`)
}
console.log(`\n  ${APPLY?'APPLYING':'DRY RUN'} → keep ${keep} rows, clear externalTargetId on ${clear}`)
if (APPLY && toClear.length) {
  const r = await prisma.adTarget.updateMany({ where:{ id:{ in: toClear } },
    data:{ externalTargetId: null, lastSyncStatus: null, lastSyncError: null } })
  console.log(`  ✅ cleared ${r.count} rows`)
}
const after = await prisma.$queryRaw<Array<{total:bigint;landed:bigint}>>`
  WITH f AS (SELECT DISTINCT ON ("entityId") "entityId" FROM "AdvertisingActionLog"
             WHERE "actionType"='create_keyword' AND "userId"='automation:auto-harvest' ORDER BY "entityId","createdAt" ASC)
  SELECT COUNT(*)::bigint AS total, COUNT(*) FILTER (WHERE t."externalTargetId" IS NOT NULL)::bigint AS landed
  FROM "AdTarget" t JOIN f ON f."entityId"=t.id WHERE t."isNegative"=false`
console.log(`  engine-harvested: ${Number(after[0].total)} · at Amazon ${APPLY?'after':'before'} repair: ${Number(after[0].landed)}`)
await prisma.$disconnect()
