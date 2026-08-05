import { resolve } from 'path'; import { config } from 'dotenv'
config(); config({ path: resolve(process.cwd(), '../../.env') })
const { PrismaClient } = await import('@prisma/client'); const p = new PrismaClient()
const q=(s:string)=>p.$queryRawUnsafe<Record<string,unknown>[]>(s)
const show=(t:string,r:unknown[])=>console.log(`\n=== ${t} ===\n`+JSON.stringify(r,(_k,v)=>typeof v==='bigint'?Number(v):v,1))
show('how much actually runs WITHOUT you?', await q(`
  SELECT CASE WHEN NOT enabled THEN 'off'
              WHEN "dryRun"   THEN 'proposes only - needs your approval'
              ELSE 'AUTONOMOUS - acts on its own' END AS mode,
         COUNT(*) AS rules
  FROM "AutomationRule" WHERE domain='advertising' GROUP BY 1 ORDER BY 2 DESC`))
show('what the still-manual ones do', await q(`
  SELECT (SELECT string_agg(DISTINCT a->>'type', ', ')
          FROM jsonb_array_elements(actions) a
          WHERE a->>'type' NOT IN ('notify','alert_operator')) AS acts,
         COUNT(*) AS rules
  FROM "AutomationRule"
  WHERE domain='advertising' AND enabled AND "dryRun"
  GROUP BY 1 ORDER BY 2 DESC LIMIT 12`))
show('proposals waiting on you right now', await q(`
  SELECT status, COUNT(*) AS n FROM "AdsRuleSuggestion" GROUP BY 1`))
await p.$disconnect()
