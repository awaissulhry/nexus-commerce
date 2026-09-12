/** READ-ONLY. GX.4 — the Explorer reports what Amazon reported; the campaign detail page
 *  ALLOCATES the campaign total down by product-ad share. Quantify how far apart they land. */
import '../src/env.js'
const { default: prisma } = await import('../src/db.js')
const { computeCampaignDetailMetrics } = await import('../src/services/advertising/ads-detail-metrics.service.js')
const { hierarchyChildren } = await import('../src/services/advertising/ads-hierarchy.service.js')

const q = (s: string) => prisma.$queryRawUnsafe<Record<string,unknown>[]>(s)
const DAYS_SQL = Number(process.env.GX_DAYS ?? 56)
const camps = await q(`
  SELECT c.id, c.name, c."externalCampaignId" AS ext, ROUND((SUM(p."costMicros")/1e6)::numeric,2)::text AS spend
  FROM "AmazonAdsDailyPerformance" p JOIN "Campaign" c ON c.id=p."localEntityId"
  WHERE p."entityType"='CAMPAIGN' AND p.marketplace='IT' AND p.date >= CURRENT_DATE - ${DAYS_SQL}
    AND p."reportRunId" IS DISTINCT FROM 'ams-stream'
  GROUP BY 1,2,3 ORDER BY SUM(p."costMicros") DESC LIMIT 4`)

const DAYS = Number(process.env.GX_DAYS ?? 56)
const from = new Date(Date.now() - DAYS*864e5), to = new Date()
for (const c of camps) {
  const groups = await q(`
    SELECT g.id, COALESCE(json_agg(a.id) FILTER (WHERE a.id IS NOT NULL), '[]') AS ads
    FROM "AdGroup" g LEFT JOIN "AdProductAd" a ON a."adGroupId"=g.id
    WHERE g."campaignId"='${c.id}' GROUP BY 1`)
  const d = await computeCampaignDetailMetrics({
    campaignId: String(c.id), externalCampaignId: c.ext ? String(c.ext) : null,
    adGroups: groups.map(g => ({ id: String(g.id), productAdIds: (g.ads as string[]) ?? [] })),
    windowDays: DAYS, since: from, until: to,
  })
  const allocSum = [...d.byAdGroup.values()].reduce((s, m) => s + m.spendCents, 0) / 100
  const t = await hierarchyChildren({ level: 'campaign', parentId: `campaign:${c.id}`,
    from: from.toISOString().slice(0,10), to: to.toISOString().slice(0,10), decompose: 'product', marketplaces: [] })
  const reported = t.nodes.filter(n => n.kind !== 'remainder').reduce((s,n)=>s+(n.metrics.cost??0),0)
  const rem = t.nodes.find(n => n.kind === 'remainder')?.metrics.cost ?? 0
  console.log(`\n${String(c.name).slice(0,30).padEnd(32)} campaign €${c.spend}`)
  console.log(`  detail page  Σ ad groups €${allocSum.toFixed(2).padStart(9)}  (ALLOCATED — always equals the campaign)`)
  console.log(`  explorer     Σ products  €${reported.toFixed(2).padStart(9)}  + remainder €${rem.toFixed(2)}`)
  console.log(`  a product row differs by €${(allocSum - reported).toFixed(2)} between the two surfaces`)
}
await prisma.$disconnect()
