/** Are v3-report rows and 'ams' rows duplicating the same campaign-day? READ-ONLY. */
import { resolve } from 'path'; import { config } from 'dotenv'
config(); config({ path: resolve('/Users/awais/nexus-commerce/.env') })
const { PrismaClient } = await import('@prisma/client')
const p = new PrismaClient({ log: [] })
const j=(x:unknown)=>JSON.stringify(x,(_k,v)=>typeof v==='bigint'?Number(v):v)

console.log('every profileId writing CAMPAIGN rows, all time:')
console.log(j(await p.$queryRawUnsafe(`
  SELECT "profileId", "marketplace", COUNT(*)::int rows, MIN("date")::text first, MAX("date")::text last,
         SUM("impressions")::bigint impressions
  FROM "AmazonAdsDailyPerformance" WHERE "entityType"='CAMPAIGN'
  GROUP BY 1,2 ORDER BY 3 DESC`)))

console.log('\nCAMPAIGN-DAYS present under BOTH a real profile and "ams" (a double count if so):')
console.log(j(await p.$queryRawUnsafe(`
  SELECT COUNT(*)::int overlapping_campaign_days,
         SUM(a.impressions)::bigint ams_impressions, SUM(b.impressions)::bigint v3_impressions
  FROM "AmazonAdsDailyPerformance" a
  JOIN "AmazonAdsDailyPerformance" b
    ON b."entityId"=a."entityId" AND b."date"=a."date" AND b."entityType"='CAMPAIGN'
   AND b."profileId" <> 'ams'
  WHERE a."entityType"='CAMPAIGN' AND a."profileId"='ams'`)))

console.log('\nsample overlapping campaign-days:')
console.log(j(await p.$queryRawUnsafe(`
  SELECT a."entityId", a."date"::text, a."impressions" ams_imp, b."impressions" v3_imp,
         a."clicks" ams_clicks, b."clicks" v3_clicks
  FROM "AmazonAdsDailyPerformance" a
  JOIN "AmazonAdsDailyPerformance" b
    ON b."entityId"=a."entityId" AND b."date"=a."date" AND b."entityType"='CAMPAIGN' AND b."profileId" <> 'ams'
  WHERE a."entityType"='CAMPAIGN' AND a."profileId"='ams'
  ORDER BY a."date" DESC LIMIT 6`)))
await p.$disconnect()
