import { resolve } from 'path'; import { config } from 'dotenv'
config(); config({ path: resolve(process.cwd(), '../../.env') })
const { PrismaClient } = await import('@prisma/client'); const p = new PrismaClient()
const q=(s:string)=>p.$queryRawUnsafe<Record<string,unknown>[]>(s)
const show=(t:string,r:unknown[])=>console.log(`\n=== ${t} ===\n`+JSON.stringify(r,(_k,v)=>typeof v==='bigint'?Number(v):v,1))
show('what grain is actually ingested? (30d)', await q(`
  SELECT "entityType", COUNT(*) AS rows, SUM(clicks) AS clicks,
         ROUND((SUM("costMicros")/1000000.0)::numeric,2) AS spend_eur,
         SUM(COALESCE("orders7d",0)) AS orders
  FROM "AmazonAdsDailyPerformance" WHERE date > now() - interval '30 days'
  GROUP BY 1 ORDER BY 2 DESC`))
show('AdTarget stored aggregates (the other possible source)', await q(`
  SELECT COUNT(*) AS targets,
         COUNT(*) FILTER (WHERE "spendCents" > 0) AS with_spend,
         COUNT(*) FILTER (WHERE "spendCents" > 0 AND COALESCE("salesCents",0)=0) AS spend_no_sales,
         ROUND((SUM("spendCents") FILTER (WHERE "spendCents">0 AND COALESCE("salesCents",0)=0)/100.0)::numeric,2) AS wasted_eur
  FROM "AdTarget"`))
show('search-term level waste (AmazonAdsSearchTerm)', await q(`
  SELECT COUNT(*) AS rows,
         COUNT(*) FILTER (WHERE COALESCE("costCents",0)>0 AND COALESCE("orders",0)=0) AS zero_sale_terms,
         ROUND((SUM("costCents") FILTER (WHERE COALESCE("costCents",0)>0 AND COALESCE("orders",0)=0)/100.0)::numeric,2) AS wasted_eur
  FROM "AmazonAdsSearchTerm"`))
await p.$disconnect()
