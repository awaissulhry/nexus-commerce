import '../src/env.js'
const { default: prisma } = await import('../src/db.js')
const r = await prisma.$queryRawUnsafe<Record<string, unknown>[]>(`
  SELECT c.name, c.status, c.marketplace,
         COALESCE(SUM(d.impressions),0) AS impr_30d,
         COALESCE(SUM(d.clicks),0) AS clicks_30d,
         ROUND(COALESCE(SUM(d."costMicros")/1e6,0)::numeric, 2) AS spend_eur
  FROM "Campaign" c
  LEFT JOIN "AmazonAdsDailyPerformance" d
    ON d."entityType"='CAMPAIGN' AND d."entityId"=c."externalCampaignId"
   AND d.date > now() - interval '30 days'
  WHERE UPPER(c.name) LIKE '%AIREON%'
  GROUP BY 1,2,3 ORDER BY impr_30d DESC LIMIT 12`)
console.table(r.map(x => ({ ...x, impr_30d: Number(x.impr_30d), clicks_30d: Number(x.clicks_30d) })))
const tot = await prisma.$queryRawUnsafe<Record<string, unknown>[]>(`
  SELECT COUNT(*) AS campaigns, COUNT(*) FILTER (WHERE c.status='ENABLED') AS enabled
  FROM "Campaign" c WHERE UPPER(c.name) LIKE '%AIREON%'`)
console.log('totals:', tot)
await prisma.$disconnect()
process.exit(0)
