import { config } from 'dotenv'
config({ path: '/Users/awais/nexus-commerce/.env' })
const { PrismaClient } = await import('@prisma/client'); const p = new PrismaClient()
const q=(s:string)=>p.$queryRawUnsafe<Record<string,unknown>[]>(s)
const show=(t:string,r:unknown[])=>console.log(`\n=== ${t} ===\n`+JSON.stringify(r,(_k,v)=>typeof v==='bigint'?Number(v):v,1))
show('executions per day, last 8 days, by status', await q(`
  SELECT date_trunc('day',"startedAt")::date::text AS day, status, COUNT(*) AS n
  FROM "AutomationRuleExecution" WHERE "startedAt" > now() - interval '8 days'
  GROUP BY 1,2 ORDER BY 1 DESC, 3 DESC`))
show('top failure reasons last 7 days', await q(`
  SELECT left(coalesce("errorMessage",'(null)'),70) AS reason, COUNT(*) AS n,
         MAX("startedAt")::text AS newest
  FROM "AutomationRuleExecution"
  WHERE "startedAt" > now() - interval '7 days' AND status='FAILED'
  GROUP BY 1 ORDER BY 2 DESC LIMIT 8`))
show('failures in the last 3 HOURS (post-fix)', await q(`
  SELECT left(coalesce("errorMessage",'(null)'),70) AS reason, COUNT(*) AS n
  FROM "AutomationRuleExecution"
  WHERE "startedAt" > now() - interval '3 hours' AND status='FAILED'
  GROUP BY 1 ORDER BY 2 DESC LIMIT 8`))
await p.$disconnect()
