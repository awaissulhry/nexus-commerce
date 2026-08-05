import { config } from 'dotenv'
config({ path: '/Users/awais/nexus-commerce/.env' })
const { PrismaClient } = await import('@prisma/client'); const p = new PrismaClient()
const q=(s:string)=>p.$queryRawUnsafe<Record<string,unknown>[]>(s)
const show=(t:string,r:unknown[])=>console.log(`\n=== ${t} ===\n`+JSON.stringify(r,(_k,v)=>typeof v==='bigint'?Number(v):v,1))
show('suppressed campaigns by owner', await q(`
  SELECT COALESCE("bidsSuppressedBy",'(null — pre-column)') AS owner, COUNT(*) AS n,
         MAX("bidsSuppressedAt")::text AS newest
  FROM "Campaign" WHERE "bidsSuppressedAt" IS NOT NULL GROUP BY 1 ORDER BY 2 DESC`))
show('rank-defend cron activity since the deploy (23:14Z)', await q(`
  SELECT "jobName", status, COUNT(*) AS n, MAX("startedAt")::text AS last
  FROM "CronRun" WHERE "startedAt" > timestamp '2026-08-04 23:14:40'
    AND "jobName" IN ('ad-rank-defend','ad-dayparting','ad-budget-enforce')
  GROUP BY 1,2 ORDER BY 1`))
await p.$disconnect()
