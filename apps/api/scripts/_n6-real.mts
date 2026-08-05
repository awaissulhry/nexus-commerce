import { resolve } from 'path'; import { config } from 'dotenv'
config(); config({ path: resolve(process.cwd(), '../../.env') })
const { PrismaClient } = await import('@prisma/client'); const p = new PrismaClient()
const q=(s:string)=>p.$queryRawUnsafe<Record<string,unknown>[]>(s)
const show=(t:string,r:unknown[])=>console.log(`\n=== ${t} ===\n`+JSON.stringify(r,(_k,v)=>typeof v==='bigint'?Number(v):v,1))
show('date span of search-term data', await q(`
  SELECT MIN(date)::text AS oldest, MAX(date)::text AS newest, COUNT(DISTINCT date) AS days
  FROM "AmazonAdsSearchTerm"`))
show('zero-sale search-term spend, LAST 30 DAYS, by marketplace', await q(`
  SELECT marketplace,
         ROUND((SUM("costMicros")/1000000.0)::numeric,2) AS wasted_eur,
         COUNT(*) AS terms, SUM(clicks) AS clicks
  FROM "AmazonAdsSearchTerm"
  WHERE date > now() - interval '30 days' AND "costMicros" > 0 AND COALESCE("orders7d",0) = 0
  GROUP BY 1 ORDER BY 2 DESC`))
show('the actionable tail: terms costing >EUR 2 with no orders (30d)', await q(`
  SELECT "searchTerm", marketplace,
         ROUND((SUM("costMicros")/1000000.0)::numeric,2) AS eur, SUM(clicks) AS clicks
  FROM "AmazonAdsSearchTerm"
  WHERE date > now() - interval '30 days' AND COALESCE("orders7d",0)=0
  GROUP BY 1,2 HAVING SUM("costMicros")/1000000.0 >= 2
  ORDER BY 3 DESC LIMIT 12`))
await p.$disconnect()
