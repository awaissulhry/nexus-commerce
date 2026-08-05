import { resolve } from 'path'
import { config } from 'dotenv'
config(); config({ path: resolve(process.cwd(), '../../.env') })
const { PrismaClient } = await import('@prisma/client')
const p = new PrismaClient()
const q=(s:string)=>p.$queryRawUnsafe<Record<string,unknown>[]>(s)
const show=(t:string,r:unknown[])=>console.log(`\n=== ${t} ===\n`+JSON.stringify(r,(_k,v)=>typeof v==='bigint'?Number(v):v,1))

show('1. shape of the queue', await q(`
  SELECT "ruleName", "proposedAction"->>'type' AS action, "entityType", COUNT(*) AS n,
         MIN("createdAt")::text AS first, MAX("createdAt")::text AS last
  FROM "AdsRuleSuggestion" WHERE status='pending'
  GROUP BY 1,2,3 ORDER BY 4 DESC`))

show('2. distinct entities touched (is it 227 real changes or 227 rows about a few things?)', await q(`
  SELECT COUNT(*) AS rows, COUNT(DISTINCT "entityId") AS distinct_entities,
         COUNT(DISTINCT "ruleId") AS rules
  FROM "AdsRuleSuggestion" WHERE status='pending'`))

show('3. ⚠ anything that would PAUSE or STOP delivery', await q(`
  SELECT "ruleName", "entityName", left("proposedAction"::text,150) AS proposal
  FROM "AdsRuleSuggestion" WHERE status='pending'
    AND ("proposedAction"::text ILIKE '%pause%' OR "proposedAction"::text ILIKE '%archive%'
         OR "proposedAction"::text ILIKE '%floor%')
  LIMIT 10`))

show('4. proposals with a wouldChange / noChange marker', await q(`
  SELECT COALESCE("proposedAction"->>'wouldChange','<absent>') AS would_change,
         COALESCE("proposedAction"->>'noChange','<absent>') AS no_change, COUNT(*) AS n
  FROM "AdsRuleSuggestion" WHERE status='pending' GROUP BY 1,2 ORDER BY 3 DESC LIMIT 8`))
await p.$disconnect()
