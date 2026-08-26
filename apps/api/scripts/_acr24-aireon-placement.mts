import '../src/env.js'
const { default: prisma } = await import('../src/db.js')
const r = await prisma.$queryRawUnsafe<Record<string, unknown>[]>(`
  SELECT p.placement, COALESCE(SUM(p.impressions),0) AS impr, COALESCE(SUM(p.clicks),0) AS clicks
  FROM "AmazonAdsPlacementReport" p
  JOIN "Campaign" c ON c."externalCampaignId" = p."campaignId"
  WHERE p.marketplace='IT' AND p.date > now() - interval '30 days'
    AND UPPER(c.name) LIKE '%AIREON%'
  GROUP BY 1 ORDER BY impr DESC`)
console.table(r.map(x => ({ placement: x.placement, impr: Number(x.impr), clicks: Number(x.clicks) })))
await prisma.$disconnect()
process.exit(0)
