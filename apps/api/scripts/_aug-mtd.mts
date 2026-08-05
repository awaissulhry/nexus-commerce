import { config } from 'dotenv'
config({ path: '/Users/awais/nexus-commerce/.env' })
const { PrismaClient } = await import('@prisma/client'); const p = new PrismaClient()
const r = await p.$queryRawUnsafe<Record<string,unknown>[]>(`
  SELECT marketplace, round((SUM("costMicros")/1e6)::numeric,2) AS mtd_eur
  FROM "AmazonAdsDailyPerformance"
  WHERE "entityType"='CAMPAIGN' AND to_char(date,'YYYY-MM')='2026-08'
  GROUP BY 1 ORDER BY 2 DESC`)
console.log('August MTD:', JSON.stringify(r,(_k,v)=>typeof v==='bigint'?Number(v):v,1))
await p.$disconnect()
