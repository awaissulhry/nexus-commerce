import { resolve } from 'path'
import { config } from 'dotenv'
config(); config({ path: resolve(process.cwd(), '../../.env') })
const { PrismaClient } = await import('@prisma/client')
const p = new PrismaClient()
const q = (s:string)=>p.$queryRawUnsafe<Record<string,unknown>[]>(s)
const show=(t:string,r:unknown[])=>console.log(`\n=== ${t} ===\n`+JSON.stringify(r,(_k,v)=>typeof v==='bigint'?Number(v):v,1))
show('one rule, today: execution mix by status (proves the ratchet)', await q(`
  SELECT r.name, r."maxExecutionsPerDay" AS cap, e.status, COUNT(*) AS n
  FROM "AutomationRuleExecution" e JOIN "AutomationRule" r ON r.id = e."ruleId"
  WHERE e."startedAt" >= date_trunc('day', now() AT TIME ZONE 'UTC')
    AND r.name = '🎯 Bid optimization (profit-native)'
  GROUP BY 1,2,3 ORDER BY 4 DESC`))
show('account-wide today: status mix', await q(`
  SELECT status, COUNT(*) AS n FROM "AutomationRuleExecution"
  WHERE "startedAt" >= date_trunc('day', now() AT TIME ZONE 'UTC') GROUP BY 1 ORDER BY 2 DESC`))
show('caps configured on advertising rules', await q(`
  SELECT "maxExecutionsPerDay" AS cap, COUNT(*) AS rules
  FROM "AutomationRule" WHERE domain='advertising' GROUP BY 1 ORDER BY 2 DESC`))
show('did ANY execution ever succeed?', await q(`
  SELECT status, COUNT(*) AS n, MIN("startedAt")::text AS first, MAX("startedAt")::text AS last
  FROM "AutomationRuleExecution" GROUP BY 1 ORDER BY 2 DESC`))
await p.$disconnect()
