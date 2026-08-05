import { resolve } from 'path'
import { config } from 'dotenv'
config(); config({ path: resolve('/Users/awais/nexus-commerce/.env') })
const { PrismaClient } = await import('@prisma/client')
const p = new PrismaClient()
const q = (s:string)=>p.$queryRawUnsafe<any[]>(s)
const n=(v:any)=>typeof v==='bigint'?Number(v):v
const show=(r:any[])=>r.length?r.forEach(x=>console.log('  '+Object.entries(x).map(([k,v])=>`${k}=${n(v)}`).join('  '))):console.log('  (none)')
show(await q(`SELECT now()::text AS now_utc`))
console.log('\n— placement writes since the resume (10:25), with mode —')
show(await q(`SELECT "createdAt"::text AS at, "amazonResponseStatus" AS status,
   ("payloadAfter"->>'mode') AS mode, COUNT(*) OVER () AS total
  FROM "AdvertisingActionLog"
  WHERE "actionType"='update_placement_bidding' AND "createdAt" > timestamp '2026-08-05 10:25:45'
  ORDER BY "createdAt" DESC LIMIT 5`))
console.log('\n— breaker state + last check —')
show(await q(`SELECT halted, "maxActionsPerHour", "lastCheckedAt"::text AS last_check, LEFT(COALESCE("haltReason",'-'),50) AS reason
  FROM "AdsAutomationState" WHERE id='singleton'`))
console.log('\n— rule executions this hour (vs the 500 limit) —')
show(await q(`SELECT COUNT(*)::int AS actions_this_hour FROM "AutomationRuleExecution" e
  JOIN "AutomationRule" r ON r.id=e."ruleId"
  WHERE r.domain='advertising' AND e.status IN ('SUCCESS','PARTIAL') AND e."startedAt" > now() - interval '1 hour'`))
await p.$disconnect(); process.exit(0)
