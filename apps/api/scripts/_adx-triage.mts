import { resolve } from 'path'
import { config } from 'dotenv'
config(); config({ path: resolve(process.cwd(), '../../.env') })
const { PrismaClient } = await import('@prisma/client')
const p = new PrismaClient()
const q=(s:string)=>p.$queryRawUnsafe<Record<string,unknown>[]>(s)
const show=(t:string,r:unknown[])=>console.log(`\n=== ${t} ===\n`+JSON.stringify(r,(_k,v)=>typeof v==='bigint'?Number(v):v,1))

// Rules whose actions overlap what the rank/dayparting CRON already owns.
const ENGINE_ACTIONS = `('defend_top_of_search','refresh_dayparting','set_placement_multiplier','raise_bids_for_rank_defense')`
show('A. rules that duplicate the rank/dayparting ENGINE', await q(`
  SELECT COUNT(*) AS rules, SUM(CASE WHEN enabled THEN 1 ELSE 0 END) AS enabled FROM "AutomationRule"
  WHERE domain='advertising' AND EXISTS (
    SELECT 1 FROM jsonb_array_elements(actions) a WHERE a->>'type' IN ${ENGINE_ACTIONS})`))
show('B. exact-duplicate names (same name >1 row)', await q(`
  SELECT name, COUNT(*) AS copies, SUM(CASE WHEN enabled THEN 1 ELSE 0 END) AS enabled
  FROM "AutomationRule" WHERE domain='advertising'
  GROUP BY name HAVING COUNT(*) > 1 ORDER BY 2 DESC`))
show('C. rules doing work the engine does NOT do (the keepers)', await q(`
  SELECT name, trigger, enabled, "maxExecutionsPerDay" AS cap,
         (SELECT string_agg(DISTINCT a->>'type', ',') FROM jsonb_array_elements(actions) a
           WHERE a->>'type' NOT IN ('notify','alert_operator')) AS actions
  FROM "AutomationRule" WHERE domain='advertising'
    AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(actions) a WHERE a->>'type' IN ${ENGINE_ACTIONS})
  ORDER BY enabled DESC, name`))
show('D. totals', await q(`
  SELECT COUNT(*) AS all_rules, SUM(CASE WHEN enabled THEN 1 ELSE 0 END) AS enabled
  FROM "AutomationRule" WHERE domain='advertising'`))
await p.$disconnect()
