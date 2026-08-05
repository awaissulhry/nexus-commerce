import { config } from 'dotenv'
config({ path: '/Users/awais/nexus-commerce/.env' })
const { PrismaClient } = await import('@prisma/client'); const p = new PrismaClient()
const q=(s:string)=>p.$queryRawUnsafe<Record<string,unknown>[]>(s)
const show=(t:string,r:unknown[])=>console.log(`\n=== ${t} ===\n`+JSON.stringify(r,(_k,v)=>typeof v==='bigint'?Number(v):v,1))
show('AdvertisingActionLog per minute, last 40 min: total vs with evidence', await q(`
  SELECT to_char(date_trunc('minute',"createdAt"),'HH24:MI') AS minute,
         COUNT(*) AS rows, COUNT(*) FILTER (WHERE evidence IS NOT NULL) AS with_evidence
  FROM "AdvertisingActionLog" WHERE "createdAt" > now() - interval '40 minutes'
  GROUP BY 1 ORDER BY 1 DESC LIMIT 12`))
show('CampaignBidHistory per minute, last 40 min', await q(`
  SELECT to_char(date_trunc('minute',"changedAt"),'HH24:MI') AS minute, COUNT(*) AS rows
  FROM "CampaignBidHistory" WHERE "changedAt" > now() - interval '40 minutes'
  GROUP BY 1 ORDER BY 1 DESC LIMIT 12`))
await p.$disconnect()
