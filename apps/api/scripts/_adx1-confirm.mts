import { resolve } from 'path'
import { config } from 'dotenv'
config(); config({ path: resolve(process.cwd(), '../../.env') })
const { PrismaClient } = await import('@prisma/client')
const p = new PrismaClient()
const q=(s:string)=>p.$queryRawUnsafe<Record<string,unknown>[]>(s)
const show=(t:string,r:unknown[])=>console.log(`\n=== ${t} ===\n`+JSON.stringify(r,(_k,v)=>typeof v==='bigint'?Number(v):v,1))
const DEPLOY='2026-08-03 22:43:00'
show('executions since deploy', await q(`
  SELECT status, COUNT(*) AS n FROM "AutomationRuleExecution"
  WHERE "startedAt" > '${DEPLOY}'::timestamp GROUP BY 1 ORDER BY 2 DESC`))
show('NEW cap rows since deploy (must be 0)', await q(`
  SELECT COUNT(*) AS n FROM "AutomationRuleExecution"
  WHERE "startedAt" > '${DEPLOY}'::timestamp AND "errorMessage"='DAILY_CAP_EXCEEDED'`))
show('evaluator cron summaries since deploy', await q(`
  SELECT "startedAt"::text, status, "outputSummary" FROM "CronRun"
  WHERE "jobName"='advertising-rule-evaluator' AND "startedAt" > '${DEPLOY}'::timestamp
  ORDER BY "startedAt" DESC LIMIT 4`))
show('before vs after — today total', await q(`
  SELECT CASE WHEN "startedAt" > '${DEPLOY}'::timestamp THEN 'after' ELSE 'before' END AS phase,
         status, COUNT(*) AS n
  FROM "AutomationRuleExecution"
  WHERE "startedAt" >= date_trunc('day', now() AT TIME ZONE 'UTC')
  GROUP BY 1,2 ORDER BY 1 DESC, 3 DESC`))
show('suggestions (ADX.2 lands on the NEXT deploy)', await q(`
  SELECT COUNT(*) AS total, COUNT(*) FILTER (WHERE "createdAt" > '${DEPLOY}'::timestamp) AS since_deploy
  FROM "AdsRuleSuggestion"`))
await p.$disconnect()
