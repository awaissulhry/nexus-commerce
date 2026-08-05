import { resolve } from 'path'; import { config } from 'dotenv'
config(); config({ path: resolve(process.cwd(), '../../.env') })
const { PrismaClient } = await import('@prisma/client'); const p = new PrismaClient()
const q=(s:string)=>p.$queryRawUnsafe<Record<string,unknown>[]>(s)
const show=(t:string,r:unknown[])=>console.log(`\n=== ${t} ===\n`+JSON.stringify(r,(_k,v)=>typeof v==='bigint'?Number(v):v,1))
show('has ads-metrics-ingest EVER run?', await q(`
  SELECT "jobName", COUNT(*) AS runs, MAX("startedAt")::text AS last,
         COUNT(*) FILTER (WHERE status='FAILED') AS failed
  FROM "CronRun" WHERE "jobName" ILIKE '%metric%' GROUP BY 1 ORDER BY 3 DESC`))
show('stored aggregates across the hierarchy', await q(`
  SELECT 'Campaign' AS entity, COUNT(*) AS n, COUNT(*) FILTER (WHERE spend > 0) AS with_spend FROM "Campaign"
  UNION ALL SELECT 'AdGroup', COUNT(*), COUNT(*) FILTER (WHERE "spendCents" > 0) FROM "AdGroup"
  UNION ALL SELECT 'AdTarget', COUNT(*), COUNT(*) FILTER (WHERE "spendCents" > 0) FROM "AdTarget"
  UNION ALL SELECT 'AdProductAd', COUNT(*), COUNT(*) FILTER (WHERE "spendCents" > 0) FROM "AdProductAd"`))
await p.$disconnect()
