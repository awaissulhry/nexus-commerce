import '../src/env.js'
const { default: prisma } = await import('../src/db.js')
const r = await prisma.$queryRawUnsafe<Record<string, unknown>[]>(`
  SELECT pa.asin, COUNT(DISTINCT c.id) AS campaigns,
         COALESCE(SUM(d.impressions),0) AS impr_30d
  FROM "AdProductAd" pa
  JOIN "AdGroup" g ON g.id = pa."adGroupId"
  JOIN "Campaign" c ON c.id = g."campaignId"
  LEFT JOIN "AmazonAdsDailyPerformance" d
    ON d."entityType"='PRODUCT_AD' AND d."entityId"=pa."externalAdId"
   AND d.date > now() - interval '30 days'
  WHERE UPPER(c.name) LIKE '%AIREON%' AND c.status='ENABLED' AND pa.status='ENABLED'
  GROUP BY 1 ORDER BY impr_30d DESC LIMIT 30`)
console.table(r.map(x => ({ asin: x.asin, campaigns: Number(x.campaigns), impr_30d: Number(x.impr_30d) })))
await prisma.$disconnect()
process.exit(0)
