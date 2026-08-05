import { resolve } from 'path'
import { config } from 'dotenv'
config(); config({ path: resolve(process.cwd(), '../../.env') })
const { PrismaClient } = await import('@prisma/client')
const p = new PrismaClient()
const q=(s:string)=>p.$queryRawUnsafe<Record<string,unknown>[]>(s)
const show=(t:string,r:unknown[])=>console.log(`\n=== ${t} ===\n`+JSON.stringify(r,(_k,v)=>typeof v==='bigint'?Number(v):v,1))
show('CAP_EXCEEDED rows by 5-min bucket (did the fix hold?)', await q(`
  SELECT date_trunc('hour',"startedAt")::text || ':' || (EXTRACT(MINUTE FROM "startedAt")::int/5*5) AS bucket,
         COUNT(*) AS cap_rows
  FROM "AutomationRuleExecution"
  WHERE "startedAt" > now() - interval '3 hours' AND "errorMessage"='DAILY_CAP_EXCEEDED'
  GROUP BY 1 ORDER BY 1 DESC LIMIT 8`))
show('pending suggestions by proposed action type', await q(`
  SELECT "proposedAction"->>'type' AS action, COUNT(*) AS n
  FROM "AdsRuleSuggestion" WHERE status='pending' GROUP BY 1 ORDER BY 2 DESC`))
show('⚠ negative-keyword proposals — the exposure', await q(`
  SELECT "ruleName", "entityName", "proposedKey", left("proposedAction"::text,140) AS proposal
  FROM "AdsRuleSuggestion" WHERE status='pending'
    AND ("proposedAction"->>'type' ILIKE '%negative%' OR "proposedKey" ILIKE '%negative%')
  LIMIT 8`))
show('suggestions by rule', await q(`
  SELECT "ruleName", COUNT(*) AS n FROM "AdsRuleSuggestion" WHERE status='pending'
  GROUP BY 1 ORDER BY 2 DESC LIMIT 8`))
await p.$disconnect()
