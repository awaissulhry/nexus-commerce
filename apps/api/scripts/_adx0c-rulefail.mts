import { resolve } from 'path'
import { config } from 'dotenv'
config(); config({ path: resolve(process.cwd(), '../../.env') })
const { PrismaClient } = await import('@prisma/client')
const p = new PrismaClient()
const q = (s:string)=>p.$queryRawUnsafe<Record<string,unknown>[]>(s)
const show=(t:string,r:unknown[])=>console.log(`\n=== ${t} ===\n`+JSON.stringify(r,(_k,v)=>typeof v==='bigint'?Number(v):v,1))
show('top failure messages (90d)', await q(`
  SELECT left(COALESCE("errorMessage",'<null>'),160) AS err, COUNT(*) AS n,
         COUNT(DISTINCT "ruleId") AS rules
  FROM "AutomationRuleExecution"
  WHERE "startedAt" > now() - interval '90 days' AND status='FAILED'
  GROUP BY 1 ORDER BY 2 DESC LIMIT 10`))
show('failures by rule (top 10)', await q(`
  SELECT r.name, r.trigger, r.enabled, COUNT(*) AS failures, MAX(e."startedAt")::text AS last
  FROM "AutomationRuleExecution" e JOIN "AutomationRule" r ON r.id=e."ruleId"
  WHERE e."startedAt" > now() - interval '90 days' AND e.status='FAILED'
  GROUP BY 1,2,3 ORDER BY 4 DESC LIMIT 10`))
show('a sample failed execution (actionResults)', await q(`
  SELECT "ruleId", "errorMessage", left("actionResults"::text, 400) AS action_results,
         left("triggerData"::text, 200) AS trigger_data, "startedAt"::text
  FROM "AutomationRuleExecution"
  WHERE status='FAILED' AND "startedAt" > now() - interval '7 days'
  ORDER BY "startedAt" DESC LIMIT 3`))
show('DRY_RUN executions — did any produce a suggestion?', await q(`
  SELECT COUNT(*) AS dry_runs,
         (SELECT COUNT(*) FROM "AdsRuleSuggestion") AS suggestions_ever
  FROM "AutomationRuleExecution"
  WHERE status='DRY_RUN' AND "startedAt" > now() - interval '90 days'`))
await p.$disconnect()
