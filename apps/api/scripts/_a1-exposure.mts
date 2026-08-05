import { resolve } from 'path'
import { config } from 'dotenv'
config(); config({ path: resolve(process.cwd(), '../../.env') })
const { PrismaClient } = await import('@prisma/client')
const p = new PrismaClient()
const q=(s:string)=>p.$queryRawUnsafe<Record<string,unknown>[]>(s)
const show=(t:string,r:unknown[])=>console.log(`\n=== ${t} ===\n`+JSON.stringify(r,(_k,v)=>typeof v==='bigint'?Number(v):v,1))
show('suggestions now (ADX.2 live?)', await q(`
  SELECT status, COUNT(*) AS n, MAX("createdAt")::text AS latest FROM "AdsRuleSuggestion" GROUP BY 1`))
show('suggestions by rule', await q(`
  SELECT "ruleName", "entityType", COUNT(*) AS n FROM "AdsRuleSuggestion"
  WHERE "createdAt" > now() - interval '1 day' GROUP BY 1,2 ORDER BY 3 DESC LIMIT 10`))
show('executions since ADX.2 deploy', await q(`
  SELECT status, COUNT(*) AS n FROM "AutomationRuleExecution"
  WHERE "startedAt" > now() - interval '90 minutes' GROUP BY 1`))
show('negative-keyword actions ever taken (the exposure surface)', await q(`
  SELECT "actionType", COUNT(*) AS n, MAX("createdAt")::text AS latest
  FROM "AdvertisingActionLog" WHERE "actionType" ILIKE '%negative%' GROUP BY 1`))
show('brand terms at risk — keywords containing our brand', await q(`
  SELECT COUNT(*) AS brand_keywords FROM "AdTarget"
  WHERE "expression" ILIKE '%xavia%' OR "expression" ILIKE '%gale%' OR "expression" ILIKE '%aireon%'
     OR "expression" ILIKE '%moss%' OR "expression" ILIKE '%airmesh%'`))
await p.$disconnect()
