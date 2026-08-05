import { resolve } from 'path'
import { config } from 'dotenv'
config(); config({ path: resolve(process.cwd(), '../../.env') })
const { PrismaClient } = await import('@prisma/client')
const p = new PrismaClient()
const q=(s:string)=>p.$queryRawUnsafe<Record<string,unknown>[]>(s)
const show=(t:string,r:unknown[])=>console.log(`\n=== ${t} ===\n`+JSON.stringify(r,(_k,v)=>typeof v==='bigint'?Number(v):v,1))
show('signal vs noise', await q(`
  SELECT CASE
    WHEN "proposedAction"->>'type' IN ('notify','alert_operator') THEN 'NOISE: a notification, not a proposal'
    WHEN "proposedAction"->>'wouldChange' = '0'                   THEN 'NOISE: explicitly zero change'
    WHEN "entityType" = 'MARKETPLACE'                             THEN 'WEAK: aggregate entity, not approvable'
    ELSE 'SIGNAL: a specific change to a specific entity' END AS bucket,
    COUNT(*) AS n
  FROM "AdsRuleSuggestion" WHERE status='pending' GROUP BY 1 ORDER BY 2 DESC`))
show('the actual signal — every entity-level proposal', await q(`
  SELECT "ruleName", "entityType", "entityName", left("proposedAction"::text,120) AS proposal
  FROM "AdsRuleSuggestion" WHERE status='pending'
    AND "proposedAction"->>'type' NOT IN ('notify','alert_operator')
    AND COALESCE("proposedAction"->>'wouldChange','') <> '0'
    AND "entityType" <> 'MARKETPLACE'
  ORDER BY "ruleName" LIMIT 15`))
show('were any created AFTER the 22:0x consolidation?', await q(`
  SELECT "ruleName", COUNT(*) AS n, MAX("createdAt")::text AS latest
  FROM "AdsRuleSuggestion" WHERE status='pending' AND "createdAt" > '2026-08-03 23:06:00'
  GROUP BY 1 ORDER BY 2 DESC LIMIT 6`))
await p.$disconnect()
