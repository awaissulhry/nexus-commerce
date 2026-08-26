import '../src/env.js'
const { default: prisma } = await import('../src/db.js')
const fam = await prisma.$queryRawUnsafe<Record<string, unknown>[]>(`
  SELECT CASE WHEN UPPER(c.name) LIKE '%AIREON%' THEN 'AIREON' ELSE 'GALE' END AS family,
         COALESCE(SUM(d.impressions),0) AS impr,
         ROUND(COALESCE(SUM(d."costMicros")/1e6,0)::numeric,2) AS eur
  FROM "Campaign" c
  JOIN "AmazonAdsDailyPerformance" d ON d."entityType"='CAMPAIGN' AND d."entityId"=c."externalCampaignId"
   AND d.date BETWEEN '2026-07-26' AND '2026-08-01'
  WHERE c.marketplace='IT' AND (UPPER(c.name) LIKE '%AIREON%' OR UPPER(c.name) LIKE '%GALE%')
  GROUP BY 1`)
console.log('campaign activity IN the 07-26→08-01 week:', fam)
const pl = await prisma.$queryRawUnsafe<Record<string, unknown>[]>(`
  SELECT p.placement, COALESCE(SUM(p.impressions),0) AS impr
  FROM "AmazonAdsPlacementReport" p
  JOIN "Campaign" c ON c."externalCampaignId" = p."campaignId"
  WHERE p.marketplace='IT' AND p.date BETWEEN '2026-07-26' AND '2026-08-01'
    AND UPPER(c.name) LIKE '%AIREON%'
  GROUP BY 1 ORDER BY impr DESC`)
console.log('AIREON placement split in that week:', pl)
const tos = await prisma.$queryRawUnsafe<Record<string, unknown>[]>(`
  SELECT MIN(date)::text AS from_d, MAX(date)::text AS to_d, COUNT(DISTINCT "campaignId") AS campaigns,
         ROUND(AVG("topOfSearchIS")::numeric, 4) AS avg_tos_is
  FROM "AmazonAdsPlacementReport" WHERE "topOfSearchIS" IS NOT NULL`)
console.log('topOfSearchIS coverage:', tos)
await prisma.$disconnect()
process.exit(0)
