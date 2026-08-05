import { resolve } from 'path'; import { config } from 'dotenv'
config(); config({ path: resolve(process.cwd(), '../../.env') })
const { PrismaClient } = await import('@prisma/client'); const p = new PrismaClient()
const q=(s:string)=>p.$queryRawUnsafe<Record<string,unknown>[]>(s)
const show=(t:string,r:unknown[])=>console.log(`\n=== ${t} ===\n`+JSON.stringify(r,(_k,v)=>typeof v==='bigint'?Number(v):v,1))
show('AutopilotPlans — what would actually act?', await q(`
  SELECT enabled, autonomy, goal, marketplace, COUNT(*) AS plans
  FROM "AutopilotPlan" GROUP BY 1,2,3,4 ORDER BY 5 DESC`))
show('total plans', await q(`SELECT COUNT(*) AS n FROM "AutopilotPlan"`))
show('recent autopilot cron outcome', await q(`
  SELECT status, COUNT(*) AS n, MAX("startedAt")::text AS last, left(MAX("outputSummary"),120) AS sample
  FROM "CronRun" WHERE "jobName"='ad-autopilot' AND "startedAt" > now() - interval '2 days'
  GROUP BY 1 ORDER BY 2 DESC`))
await p.$disconnect()
