import { resolve } from 'path'; import { config } from 'dotenv'
config(); config({ path: resolve(process.cwd(), '../../.env') })
const { PrismaClient } = await import('@prisma/client'); const p = new PrismaClient()
const q=(s:string)=>p.$queryRawUnsafe<Record<string,unknown>[]>(s)
const show=(t:string,r:unknown[])=>console.log(`\n=== ${t} ===\n`+JSON.stringify(r,(_k,v)=>typeof v==='bigint'?Number(v):v,1))

show('1. zero-sale spend by market (30d): clicks paid for, nothing sold', await q(`
  SELECT marketplace,
         ROUND((SUM("costMicros")/1000000.0)::numeric,2) AS wasted_eur,
         SUM(clicks) AS clicks, COUNT(DISTINCT "entityId") AS targets
  FROM "AmazonAdsDailyPerformance"
  WHERE "entityType"='AD_TARGET' AND date > now() - interval '30 days'
  GROUP BY 1 HAVING SUM(COALESCE("orders7d",0))=0 AND SUM(clicks)>0 ORDER BY 2 DESC`))

show('2. worst individual targets', await q(`
  SELECT "entityId", ROUND((SUM("costMicros")/1000000.0)::numeric,2) AS wasted_eur, SUM(clicks) AS clicks
  FROM "AmazonAdsDailyPerformance"
  WHERE "entityType"='AD_TARGET' AND date > now() - interval '30 days'
  GROUP BY 1 HAVING SUM(COALESCE("orders7d",0))=0 AND SUM(clicks)>0
  ORDER BY 2 DESC LIMIT 6`))

show('3. account totals (30d)', await q(`
  SELECT ROUND((SUM("costMicros")/1000000.0)::numeric,2) AS spend_eur,
         ROUND((SUM(COALESCE("sales7dCents",0))/100.0)::numeric,2) AS sales_eur,
         SUM(clicks) AS clicks, SUM(COALESCE("orders7d",0)) AS orders
  FROM "AmazonAdsDailyPerformance"
  WHERE "entityType"='CAMPAIGN' AND date > now() - interval '30 days'`))

show('4. ProductProfitDaily populated?', await q(`
  SELECT COUNT(*) AS rows, MAX(date)::text AS latest, COUNT(DISTINCT "productId") AS products
  FROM "ProductProfitDaily" WHERE date > now() - interval '30 days'`))

show('5. other priceable problems', await q(`
  SELECT 'ads dead letters' AS problem, COUNT(*) AS n FROM "OutboundSyncQueue"
   WHERE "syncStatus"='FAILED' AND "targetChannel"='AMAZON'
  UNION ALL SELECT 'orphaned ad targets', COUNT(*) FROM "AdTarget" WHERE "orphanedAt" IS NOT NULL
  UNION ALL SELECT 'campaigns unsellable (retail watch)', COUNT(*) FROM "Campaign" WHERE status='ENABLED'`))
await p.$disconnect()
