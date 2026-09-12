/** READ-ONLY — does the intraday overlay contribute now? */
import '../src/env.js'
const { default: prisma } = await import('../src/db.js')
const { computeCampaignDetailMetrics } = await import('../src/services/advertising/ads-detail-metrics.service.js')
const c = (await prisma.$queryRawUnsafe<Record<string,unknown>[]>(`
  SELECT c.id, c.name, c."externalCampaignId" AS ext
  FROM "AmazonAdsHourlyPerformance" h JOIN "Campaign" c ON c.id = h."localEntityId"
  WHERE h."entityType"='CAMPAIGN' AND h.date = CURRENT_DATE
  GROUP BY 1,2,3 ORDER BY SUM(h."costMicros") DESC LIMIT 1`))[0]
const groups = await prisma.$queryRawUnsafe<Record<string,unknown>[]>(`
  SELECT g.id, COALESCE(json_agg(a.id) FILTER (WHERE a.id IS NOT NULL),'[]') AS ads
  FROM "AdGroup" g LEFT JOIN "AdProductAd" a ON a."adGroupId"=g.id WHERE g."campaignId"='${c.id}' GROUP BY 1`)
const today = new Date(); today.setHours(0,0,0,0)
const r = await computeCampaignDetailMetrics({
  campaignId: String(c.id), externalCampaignId: c.ext ? String(c.ext) : null,
  adGroups: groups.map(g=>({ id: String(g.id), productAdIds: (g.ads as string[]) ?? [] })),
  windowDays: 1, since: today, until: new Date(),
})
console.log(`campaign: ${c.name}`)
console.log(`TODAY on the campaign detail page: €${(r.campaign.spendCents/100).toFixed(2)} spend · ${r.campaign.clicks} clicks · ${r.campaign.impressions} impressions`)
await prisma.$disconnect()
