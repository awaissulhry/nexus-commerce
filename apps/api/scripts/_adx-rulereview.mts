import { resolve } from 'path'
import { config } from 'dotenv'
config(); config({ path: resolve(process.cwd(), '../../.env') })
const { PrismaClient } = await import('@prisma/client')
const p = new PrismaClient()
const q=(s:string)=>p.$queryRawUnsafe<Record<string,unknown>[]>(s)
const show=(t:string,r:unknown[])=>console.log(`\n=== ${t} ===\n`+JSON.stringify(r,(_k,v)=>typeof v==='bigint'?Number(v):v,1))
show('rules by action type — what do they actually change?', await q(`
  SELECT a->>'type' AS action_type, COUNT(*) AS rules,
         SUM(CASE WHEN enabled THEN 1 ELSE 0 END) AS enabled
  FROM "AutomationRule", LATERAL jsonb_array_elements(actions) a
  WHERE domain='advertising' GROUP BY 1 ORDER BY 2 DESC`))
show('near-duplicate rules (same trigger + same first action)', await q(`
  SELECT trigger, actions->0->>'type' AS first_action, COUNT(*) AS rules,
         string_agg(name, ' | ' ORDER BY name) AS names
  FROM "AutomationRule" WHERE domain='advertising'
  GROUP BY 1,2 HAVING COUNT(*) > 1 ORDER BY 3 DESC LIMIT 8`))
show('SCHEDULE rules — these fire every tick regardless of any signal', await q(`
  SELECT name, enabled, "maxExecutionsPerDay" AS cap
  FROM "AutomationRule" WHERE domain='advertising' AND trigger='SCHEDULE'
  ORDER BY enabled DESC, name LIMIT 25`))
await p.$disconnect()
