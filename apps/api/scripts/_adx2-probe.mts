import { resolve } from 'path'
import { config } from 'dotenv'
config(); config({ path: resolve(process.cwd(), '../../.env') })
const { PrismaClient } = await import('@prisma/client')
const p = new PrismaClient()
const q=(s:string)=>p.$queryRawUnsafe<Record<string,unknown>[]>(s)
const show=(t:string,r:unknown[])=>console.log(`\n=== ${t} ===\n`+JSON.stringify(r,(_k,v)=>typeof v==='bigint'?Number(v):v,1))
show('advertising rules: does actions[0] carry control=manual?', await q(`
  SELECT COALESCE(actions->0->>'control','<none>') AS control, COUNT(*) AS rules
  FROM "AutomationRule" WHERE domain='advertising' GROUP BY 1 ORDER BY 2 DESC`))
show('the 2 suggestions that exist — which rule made them', await q(`
  SELECT "ruleName", "entityType", status, "createdAt"::text FROM "AdsRuleSuggestion" ORDER BY "createdAt" DESC`))
show('enabled rules by trigger (what would fire once uncapped)', await q(`
  SELECT trigger, COUNT(*) AS rules, SUM(CASE WHEN enabled THEN 1 ELSE 0 END) AS enabled
  FROM "AutomationRule" WHERE domain='advertising' GROUP BY 1 ORDER BY 2 DESC LIMIT 12`))
await p.$disconnect()
