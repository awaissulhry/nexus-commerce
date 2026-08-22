/** SPC.3 — what are the rows the backfill could not fill? READ-ONLY. */
import { resolve } from 'path'; import { config } from 'dotenv'
config(); config({ path: resolve('/Users/awais/nexus-commerce/.env') })
const { PrismaClient } = await import('@prisma/client')
const p = new PrismaClient({ log: [] })
const j=(x:unknown)=>JSON.stringify(x,(_k,v)=>typeof v==='bigint'?Number(v):v)
const W = `"date" BETWEEN DATE '2026-05-18' AND DATE '2026-06-18'`
const BASE = `"entityType"='CAMPAIGN' AND "adProduct"='SPONSORED_PRODUCTS' AND "marketplace"='IT'`

console.log('filled vs unfilled in W1:')
console.log(j(await p.$queryRawUnsafe(`
  SELECT ("entityName" IS NOT NULL) AS filled, COUNT(*)::int rows,
         COUNT(DISTINCT "entityId")::int campaigns, COUNT(DISTINCT "profileId")::int profiles,
         MIN("date")::text first, MAX("date")::text last,
         SUM("impressions")::int impressions, SUM("clicks")::int clicks
  FROM "AmazonAdsDailyPerformance" WHERE ${BASE} AND ${W} GROUP BY 1`)))

console.log('\nprofileId split (is a second account involved?):')
console.log(j(await p.$queryRawUnsafe(`
  SELECT "profileId", ("entityName" IS NOT NULL) filled, COUNT(*)::int rows
  FROM "AmazonAdsDailyPerformance" WHERE ${BASE} AND ${W} GROUP BY 1,2 ORDER BY 3 DESC`)))

console.log('\ndo the unfilled campaigns still exist in our Campaign table, and with what status?')
console.log(j(await p.$queryRawUnsafe(`
  SELECT COALESCE(c."status"::text,'(not in Campaign table)') status, COUNT(DISTINCT d."entityId")::int campaigns,
         COUNT(*)::int rows
  FROM "AmazonAdsDailyPerformance" d
  LEFT JOIN "Campaign" c ON c."externalCampaignId" = d."entityId"
  WHERE ${BASE.replace(/"/g,'"').replace(/^/,'d.').replace(/ AND "/g,' AND d."')} AND d."date" BETWEEN DATE '2026-05-18' AND DATE '2026-06-18'
    AND d."entityName" IS NULL
  GROUP BY 1 ORDER BY 3 DESC`)))

console.log('\nare the unfilled rows all-zero (a campaign that simply did not run that day)?')
console.log(j(await p.$queryRawUnsafe(`
  SELECT (impressions=0 AND clicks=0) AS all_zero, COUNT(*)::int rows
  FROM "AmazonAdsDailyPerformance" WHERE ${BASE} AND ${W} AND "entityName" IS NULL GROUP BY 1`)))
await p.$disconnect()
