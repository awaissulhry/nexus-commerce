import { resolve } from 'path'
import { config } from 'dotenv'
config(); config({ path: resolve('/Users/awais/nexus-commerce/.env') })
const { PrismaClient } = await import('@prisma/client')
const p = new PrismaClient()
const q = (s:string)=>p.$queryRawUnsafe<any[]>(s)
const n=(v:any)=>typeof v==='bigint'?Number(v):v
const show=(r:any[])=>r.length?r.forEach(x=>console.log('  '+Object.entries(x).map(([k,v])=>`${k}=${n(v)}`).join('  '))):console.log('  (none)')
show(await q(`SELECT now()::text AS db_now_utc`))
console.log('\n— rank-defend ticks around the deploy (10:08) —')
show(await q(`SELECT "startedAt"::text AS at, LEFT("outputSummary",50) AS summary
  FROM "CronRun" WHERE "jobName"='ad-rank-defend' AND "startedAt" > timestamp '2026-08-05 09:30'
  ORDER BY "startedAt" DESC LIMIT 6`))
console.log('\n— placement writes logged, before vs after the deploy —')
show(await q(`SELECT
  COUNT(*) FILTER (WHERE "createdAt" BETWEEN timestamp '2026-08-05 09:30' AND timestamp '2026-08-05 10:08')::int AS before_deploy,
  COUNT(*) FILTER (WHERE "createdAt" > timestamp '2026-08-05 10:08')::int AS after_deploy
  FROM "AdvertisingActionLog" WHERE "actionType" LIKE '%placement%'`))
console.log('\n— gate denials surfacing anywhere? (action log statuses since deploy) —')
show(await q(`SELECT "actionType", "amazonResponseStatus", COUNT(*)::int AS n
  FROM "AdvertisingActionLog" WHERE "createdAt" > timestamp '2026-08-05 10:08'
  GROUP BY 1,2 ORDER BY n DESC LIMIT 8`))
await p.$disconnect(); process.exit(0)
