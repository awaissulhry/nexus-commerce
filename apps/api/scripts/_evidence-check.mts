import { config } from 'dotenv'
config({ path: '/Users/awais/nexus-commerce/.env' })
const { PrismaClient } = await import('@prisma/client'); const p = new PrismaClient()
const q=(s:string)=>p.$queryRawUnsafe<Record<string,unknown>[]>(s)
const show=(t:string,r:unknown[])=>console.log(`\n=== ${t} ===\n`+JSON.stringify(r,(_k,v)=>typeof v==='bigint'?Number(v):v,1))
show('AdvertisingActionLog — how many carry evidence?', await q(`
  SELECT COUNT(*) AS total,
         COUNT(*) FILTER (WHERE evidence IS NOT NULL) AS with_evidence,
         MAX("createdAt") FILTER (WHERE evidence IS NOT NULL)::text AS newest_evidence,
         MAX("createdAt")::text AS newest_row
  FROM "AdvertisingActionLog"`))
show('last 7 days by source', await q(`
  SELECT COALESCE(source,'(null)') AS source, COUNT(*) AS n,
         COUNT(*) FILTER (WHERE evidence IS NOT NULL) AS with_evidence
  FROM "AdvertisingActionLog" WHERE "createdAt" > now() - interval '7 days'
  GROUP BY 1 ORDER BY 2 DESC LIMIT 10`))
show('a sample evidence payload, if any', await q(`
  SELECT "createdAt"::text, source, action, evidence::text
  FROM "AdvertisingActionLog" WHERE evidence IS NOT NULL
  ORDER BY "createdAt" DESC LIMIT 3`))
await p.$disconnect()
