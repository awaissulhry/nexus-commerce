/** HV.9c.6 — verify the archive. READ-ONLY. */
import '../src/env.js'
const { default: prisma } = await import('../src/db.js')
const int=(n:any)=>Number(n).toLocaleString('en-IE')
const arch = await prisma.adTarget.count({ where:{ status:'ARCHIVED', retireReason:{ contains:'HV.9c' } } })
const withTs = await prisma.adTarget.count({ where:{ status:'ARCHIVED', retireReason:{ contains:'HV.9c' }, retiredAt:{ not:null } } })
const logs = await prisma.advertisingActionLog.count({ where:{ actionType:'archive_surplus_keyword' } })
const withEv = await prisma.advertisingActionLog.count({ where:{ actionType:'archive_surplus_keyword', evidence:{ not: undefined } } })
const actor = await prisma.advertisingActionLog.findFirst({ where:{ actionType:'archive_surplus_keyword' }, select:{ userId:true, evidence:true, payloadAfter:true } })
console.log(`\n  archived with an HV.9c reason: ${int(arch)} · with retiredAt: ${int(withTs)}`)
console.log(`  archive_surplus_keyword audit rows: ${int(logs)} · carrying evidence: ${int(withEv)}`)
console.log(`  actor: ${actor?.userId}`)
console.log(`  evidence: ${JSON.stringify(actor?.evidence).slice(0,150)}`)
// the harvest cohort, restated with ARCHIVED excluded — the honest backlog
const live = await prisma.$queryRaw<Array<{total:bigint;amz:bigint;localLive:bigint;localArch:bigint}>>`
  WITH f AS (SELECT DISTINCT ON ("entityId") "entityId" FROM "AdvertisingActionLog"
             WHERE "actionType"='create_keyword' AND "userId"='automation:auto-harvest' ORDER BY "entityId","createdAt" ASC)
  SELECT COUNT(*)::bigint AS total,
         COUNT(*) FILTER (WHERE t."externalTargetId" IS NOT NULL)::bigint AS amz,
         COUNT(*) FILTER (WHERE t."externalTargetId" IS NULL AND t.status<>'ARCHIVED')::bigint AS "localLive",
         COUNT(*) FILTER (WHERE t."externalTargetId" IS NULL AND t.status='ARCHIVED')::bigint AS "localArch"
  FROM "AdTarget" t JOIN f ON f."entityId"=t.id WHERE t."isNegative"=false`
const l=live[0]
console.log(`\n  🔴 THE COHORT NOW: ${int(l.total)} = ${int(l.amz)} at Amazon + ${int(l.localLive)} live local-only + ${int(l.localArch)} archived`)
console.log(`  the live backlog is ${Number(l.localLive)} rows.`)
await prisma.$disconnect()
