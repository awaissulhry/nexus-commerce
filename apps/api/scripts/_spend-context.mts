import { config } from 'dotenv'
config({ path: '/Users/awais/nexus-commerce/.env' })
const { PrismaClient } = await import('@prisma/client'); const p = new PrismaClient()
const q=(s:string)=>p.$queryRawUnsafe<Record<string,unknown>[]>(s)
const show=(t:string,r:unknown[])=>console.log(`\n=== ${t} ===\n`+JSON.stringify(r,(_k,v)=>typeof v==='bigint'?Number(v):v,1))
show('ad spend by month, per marketplace (CAMPAIGN grain)', await q(`
  SELECT to_char(date,'YYYY-MM') AS month, marketplace,
         round((SUM("costMicros")/1e6)::numeric, 2) AS eur,
         round(SUM("sales7dCents")/100.0, 2) AS sales_eur
  FROM "AmazonAdsDailyPerformance"
  WHERE "entityType"='CAMPAIGN' AND date > now() - interval '4 months'
  GROUP BY 1,2 ORDER BY 1 DESC, 3 DESC LIMIT 12`))
show('last 30 days total + daily average', await q(`
  SELECT round((SUM("costMicros")/1e6)::numeric,2) AS eur_30d,
         round((SUM("costMicros")/1e6/30)::numeric,2) AS eur_per_day
  FROM "AmazonAdsDailyPerformance"
  WHERE "entityType"='CAMPAIGN' AND date > now() - interval '30 days'`))
await p.$disconnect()
