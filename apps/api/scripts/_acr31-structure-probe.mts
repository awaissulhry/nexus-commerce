/** ACR.3.1b — can negatives steer the featured child at all? READ-ONLY structure probe.
 *  Negative keywords live per campaign/ad-group. Steering the lead requires ad groups
 *  where the lead's ad is separable from siblings. One family-wide ad group = unsteerable. */
import '../src/env.js'
const { default: prisma } = await import('../src/db.js')
const r = await prisma.$queryRawUnsafe<Record<string, unknown>[]>(`
  SELECT c.name AS campaign, g.name AS ad_group,
         COUNT(DISTINCT pa.asin) AS asins,
         COUNT(DISTINCT pa.id) FILTER (WHERE pa.status='ENABLED') AS enabled_ads
  FROM "Campaign" c
  JOIN "AdGroup" g ON g."campaignId" = c.id
  LEFT JOIN "AdProductAd" pa ON pa."adGroupId" = g.id
  WHERE c.marketplace='IT' AND c.status='ENABLED' AND UPPER(c.name) LIKE '%GALE%'
  GROUP BY 1, 2 ORDER BY 1, 2`)
console.table(r.map(x => ({ campaign: String(x.campaign).slice(0, 34), ad_group: String(x.ad_group).slice(0, 24), asins: Number(x.asins), enabled_ads: Number(x.enabled_ads) })))
await prisma.$disconnect()
process.exit(0)
