/**
 * HV.9c.6 — archive the surplus local-only harvested rows. Operator-approved.
 *
 * DRY RUN unless APPLY=1. Batches of 25. NOTHING IS DELETED and nothing is sent to Amazon.
 *
 * 🔴 Why archiving and not deleting: 1,665 audit rows reference these rows and
 * `AdvertisingActionLog.entityId` has no foreign key, so a delete strands the trail — the log would
 * keep asserting bid writes about objects nobody can look up. These rows are also the evidence for
 * D-A and D-B.
 *
 * 🔴 Why it works: measured 2026-08-14, ARCHIVED targets have received **0** bid writes, ever,
 * against 18,755 for non-ARCHIVED in 30 days. Archiving stops the 22/day this cohort was drawing.
 */
import '../src/env.js'
const { default: prisma } = await import('../src/db.js')
const { writeAdvertisingActionLog } = await import('../src/services/advertising/ads-mutation.service.js')
const APPLY = process.env.APPLY === '1'
const BATCH = 25
const REASON = 'HV.9c — surplus local row. The keyword exists at Amazon and is held by a different local row; this one never reached Amazon and never will. Census: docs/2026-08-11-hv-keyword-harvest-page.md#hv9c5.'

const rows = await prisma.$queryRaw<Array<{id:string;kw:string;mt:string;bid:number;st:string;camp:string;ag:string}>>`
  WITH f AS (SELECT DISTINCT ON ("entityId") "entityId" FROM "AdvertisingActionLog"
             WHERE "actionType"='create_keyword' AND "userId"='automation:auto-harvest' ORDER BY "entityId","createdAt" ASC)
  SELECT t.id, t."expressionValue" AS kw, t."expressionType" AS mt, t."bidCents" AS bid, t.status::text AS st,
         c.name AS camp, g.name AS ag
  FROM "AdTarget" t JOIN f ON f."entityId"=t.id
  JOIN "AdGroup" g ON g.id=t."adGroupId" JOIN "Campaign" c ON c.id=g."campaignId"
  WHERE t."isNegative"=false AND t."externalTargetId" IS NULL AND t.status <> 'ARCHIVED'
  ORDER BY t."createdAt"`
console.log(`\n  ${APPLY?'APPLYING':'DRY RUN'} — rows to archive: ${rows.length}`)
// safety: not one of them may hold an Amazon id
const holder = await prisma.adTarget.count({ where:{ id:{ in: rows.map(r=>r.id) }, externalTargetId:{ not:null } } })
if (holder>0) { console.error(`🔴 REFUSING — ${holder} of the set hold an Amazon id`); process.exit(1) }
console.log(`  ✅ safety: 0 of the set hold an Amazon id`)

let acted=0, refused=0, failed=0
for (let i=0;i<rows.length;i+=BATCH) {
  const batch=rows.slice(i,i+BATCH)
  let a=0,r=0,f=0
  for (const row of batch) {
    if (row.st==='ARCHIVED') { r++; continue }
    if (!APPLY) { a++; continue }
    try {
      await writeAdvertisingActionLog({
        actor: 'user:operator-hv9c' as never, actionType: 'archive_surplus_keyword', entityType: 'AD_TARGET',
        entityId: row.id, outboundQueueId: null,
        payloadBefore: { status: row.st, externalTargetId: null, bidCents: row.bid },
        payloadAfter: { status: 'ARCHIVED', reachedAmazon: false, retireReason: REASON },
        evidence: { metric: 'externalTargetId', observed: 0, threshold: 1, windowDays: 0,
          note: `Surplus duplicate: "${row.kw}" ${row.mt} in ${row.camp} › ${row.ag} exists at Amazon under a different local row. This row never reached Amazon.` } as never,
      } as never)
      await prisma.adTarget.update({ where:{ id: row.id }, data:{ status:'ARCHIVED', retiredAt: new Date(), retireReason: REASON } })
      a++
    } catch (e) { f++; console.log(`    🔴 failed ${row.id}: ${(e as Error).message.slice(0,90)}`) }
  }
  acted+=a; refused+=r; failed+=f
  console.log(`  batch ${Math.floor(i/BATCH)+1}: acted ${a} · refused ${r} · failed ${f}`)
  if (f>0) { console.error('  🔴 STOPPING — a failure in this batch'); break }
}
console.log(`\n  TOTAL — acted ${acted} · refused ${refused} · failed ${failed}`)
await prisma.$disconnect()
