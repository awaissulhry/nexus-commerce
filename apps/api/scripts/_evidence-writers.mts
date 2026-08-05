import { config } from 'dotenv'
config({ path: '/Users/awais/nexus-commerce/.env' })
const { PrismaClient } = await import('@prisma/client'); const p = new PrismaClient()
const q=(s:string)=>p.$queryRawUnsafe<Record<string,unknown>[]>(s)
const show=(t:string,r:unknown[])=>console.log(`\n=== ${t} ===\n`+JSON.stringify(r,(_k,v)=>typeof v==='bigint'?Number(v):v,1))
show('who writes evidence and who does not (last 24h)', await q(`
  SELECT "actionType", COUNT(*) AS rows,
         COUNT(*) FILTER (WHERE evidence IS NOT NULL) AS with_evidence,
         round(100.0*COUNT(*) FILTER (WHERE evidence IS NOT NULL)/COUNT(*),1) AS pct
  FROM "AdvertisingActionLog" WHERE "createdAt" > now() - interval '24 hours'
  GROUP BY 1 ORDER BY 2 DESC LIMIT 10`))
show('overall coverage', await q(`
  SELECT COUNT(*) AS total, COUNT(*) FILTER (WHERE evidence IS NOT NULL) AS with_evidence,
         round(100.0*COUNT(*) FILTER (WHERE evidence IS NOT NULL)/COUNT(*),2) AS pct
  FROM "AdvertisingActionLog"`))
await p.$disconnect()
