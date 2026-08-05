import { resolve } from 'path'
import { config } from 'dotenv'
config(); config({ path: resolve(process.cwd(), '../../.env') })
const { PrismaClient } = await import('@prisma/client')
const p = new PrismaClient()
const q = (s:string)=>p.$queryRawUnsafe<Record<string,unknown>[]>(s)
const show=(t:string,r:unknown[])=>console.log(`\n${t}\n`+JSON.stringify(r,(_k,v)=>typeof v==='bigint'?Number(v):v,1))
show('userId values on AD_BID_UPDATE:', await q(`
  SELECT "userId", COUNT(*) AS n FROM "AdvertisingActionLog"
  WHERE "actionType"='AD_BID_UPDATE' AND "createdAt" > now() - interval '90 days'
  GROUP BY 1 ORDER BY 2 DESC LIMIT 8`))
show('userId values overall:', await q(`
  SELECT COALESCE("userId",'<null>') AS uid, COUNT(*) AS n FROM "AdvertisingActionLog"
  WHERE "createdAt" > now() - interval '90 days' GROUP BY 1 ORDER BY 2 DESC LIMIT 12`))
show('rule executions: outcome mix (90d):', await q(`
  SELECT status, "dryRun", COUNT(*) AS n FROM "AutomationRuleExecution"
  WHERE "startedAt" > now() - interval '90 days' GROUP BY 1,2 ORDER BY 3 DESC LIMIT 10`))
show('enabled advertising rules: dryRun mix:', await q(`
  SELECT enabled, "dryRun", COUNT(*) AS n FROM "AutomationRule"
  WHERE domain='advertising' GROUP BY 1,2`))
show('rank-defend oscillation sample (one entity, last 20 bid writes):', await q(`
  SELECT "entityId", "previousValue", "intendedValue", actor, "createdAt"::text
  FROM "AdMutation" WHERE field='bid'
    AND "entityId" = (SELECT "entityId" FROM "AdMutation" WHERE field='bid'
                      GROUP BY 1 ORDER BY COUNT(*) DESC LIMIT 1)
  ORDER BY "createdAt" DESC LIMIT 20`))
await p.$disconnect()
