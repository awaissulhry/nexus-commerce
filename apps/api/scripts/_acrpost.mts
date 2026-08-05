import { resolve } from 'path'
import { config } from 'dotenv'
config(); config({ path: resolve('/Users/awais/nexus-commerce/.env') })
const { PrismaClient } = await import('@prisma/client')
const p = new PrismaClient()
const q = (s:string)=>p.$queryRawUnsafe<any[]>(s)
const n=(v:any)=>typeof v==='bigint'?Number(v):v
const show=(r:any[])=>r.length?r.forEach(x=>console.log('  '+Object.entries(x).map(([k,v])=>`${k}=${n(v)}`).join('  '))):console.log('  (none)')
console.log('\n— rank-defend runs since the deploy (10:08 UTC) —')
show(await q(`SELECT "startedAt"::text AS at, status, "outputSummary" FROM "CronRun"
  WHERE "jobName"='ad-rank-defend' AND "startedAt" > timestamp '2026-08-05 10:08:00'
  ORDER BY "startedAt" DESC LIMIT 6`))
console.log('\n— AdMutation activity, 30 min before vs after the deploy —')
show(await q(`SELECT
  COUNT(*) FILTER (WHERE "createdAt" BETWEEN timestamp '2026-08-05 09:38' AND timestamp '2026-08-05 10:08')::int AS before_30min,
  COUNT(*) FILTER (WHERE "createdAt" > timestamp '2026-08-05 10:08')::int AS after_deploy,
  MAX("createdAt")::text AS newest_mutation FROM "AdMutation"`))
console.log('\n— any gate denials recorded? —')
show(await q(`SELECT state, COUNT(*)::int AS n, LEFT(MAX("lastError"),80) AS sample FROM "AdMutation"
  WHERE "createdAt" > timestamp '2026-08-05 09:00' GROUP BY state ORDER BY n DESC`))
await p.$disconnect(); process.exit(0)
