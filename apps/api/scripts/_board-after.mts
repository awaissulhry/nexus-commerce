import { config } from 'dotenv'
config({ path: '/Users/awais/nexus-commerce/.env' })
const { PrismaClient } = await import('@prisma/client'); const p = new PrismaClient()
const q=(s:string)=>p.$queryRawUnsafe<Record<string,unknown>[]>(s)
const show=(t:string,r:unknown[])=>console.log(`\n=== ${t} ===\n`+JSON.stringify(r,(_k,v)=>typeof v==='bigint'?Number(v):v,1))
show('what the board shows now vs after the exclusion (top offenders)', await q(`
  SELECT r.name,
         COUNT(*) FILTER (WHERE e.status='FAILED')                                       AS failed_before,
         COUNT(*) FILTER (WHERE e.status='FAILED' AND e."errorMessage" IS DISTINCT FROM 'DAILY_CAP_EXCEEDED') AS failed_after,
         COUNT(*) FILTER (WHERE e.status IN ('SUCCESS','PARTIAL'))                        AS acted,
         COUNT(*) FILTER (WHERE e.status='DRY_RUN')                                       AS proposed
  FROM "AutomationRule" r JOIN "AutomationRuleExecution" e ON e."ruleId"=r.id
  WHERE e."startedAt" > now() - interval '7 days'
  GROUP BY r.name HAVING COUNT(*) FILTER (WHERE e.status='FAILED') > 0
  ORDER BY failed_before DESC LIMIT 8`))
await p.$disconnect()
