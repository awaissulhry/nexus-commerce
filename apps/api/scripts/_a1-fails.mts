import { resolve } from 'path'
import { config } from 'dotenv'
config(); config({ path: resolve(process.cwd(), '../../.env') })
const { PrismaClient } = await import('@prisma/client')
const p = new PrismaClient()
const q=(s:string)=>p.$queryRawUnsafe<Record<string,unknown>[]>(s)
const show=(t:string,r:unknown[])=>console.log(`\n=== ${t} ===\n`+JSON.stringify(r,(_k,v)=>typeof v==='bigint'?Number(v):v,1))
show('the 201 failures — what are they now?', await q(`
  SELECT left(COALESCE("errorMessage",'<null>'),120) AS err, COUNT(*) AS n
  FROM "AutomationRuleExecution" WHERE "startedAt" > now() - interval '90 minutes' AND status='FAILED'
  GROUP BY 1 ORDER BY 2 DESC LIMIT 6`))
show('sample failed actionResults', await q(`
  SELECT r.name, left(e."actionResults"::text, 300) AS results
  FROM "AutomationRuleExecution" e JOIN "AutomationRule" r ON r.id=e."ruleId"
  WHERE e."startedAt" > now() - interval '90 minutes' AND e.status='FAILED'
  ORDER BY e."startedAt" DESC LIMIT 3`))
show('suggestions now', await q(`
  SELECT status, COUNT(*) AS n, MAX("createdAt")::text AS latest FROM "AdsRuleSuggestion" GROUP BY 1`))
await p.$disconnect()
