import { resolve } from 'path'; import { config } from 'dotenv'
config(); config({ path: resolve(process.cwd(), '../../.env') })
const { PrismaClient } = await import('@prisma/client'); const p = new PrismaClient()
const q=(s:string)=>p.$queryRawUnsafe<Record<string,unknown>[]>(s)
console.log(JSON.stringify(await q(`
  SELECT COUNT(DISTINCT "localEntityId") AS campaigns_with_signal,
         ROUND((SUM("costMicros")/1000000.0)::numeric,2) AS spend_eur,
         SUM(clicks) AS clicks, SUM(COALESCE("orders7d",0)) AS orders
  FROM "AmazonAdsDailyPerformance"
  WHERE "entityType"='CAMPAIGN' AND "localEntityId" IS NOT NULL
    AND date >= (now() - interval '15 days')::date AND date <= (now() - interval '2 days')::date`),
  (_k,v)=>typeof v==='bigint'?Number(v):v,1))
await p.$disconnect()
