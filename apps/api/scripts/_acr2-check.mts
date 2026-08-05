import { resolve } from 'path'
import { config } from 'dotenv'
config(); config({ path: resolve('/Users/awais/nexus-commerce/.env') })
const { PrismaClient } = await import('@prisma/client')
const p = new PrismaClient()
const q=(s:string)=>p.$queryRawUnsafe<any[]>(s)
const show=(r:any[])=>r.forEach(x=>console.log(' ',Object.entries(x).map(([k,v])=>`${k}=${v}`).join('  ')))
console.log('— match types actually inside each GALE IT campaign —')
show(await q(`SELECT c.name, t."expressionType" AS match, COUNT(*)::int AS n
  FROM "AdTarget" t JOIN "AdGroup" g ON g.id=t."adGroupId" JOIN "Campaign" c ON c.id=g."campaignId"
  WHERE UPPER(c.name) LIKE '%GALE%' AND c.marketplace='IT' AND c.status='ENABLED' AND t.kind='KEYWORD'
    AND c.name ILIKE '%broad%'
  GROUP BY 1,2 ORDER BY 1,3 DESC`))
console.log('\n— GALE IT: any sales at all at target grain? —')
show(await q(`SELECT COUNT(*)::int AS target_rows,
    SUM(d.impressions)::int AS impr, SUM(d.clicks)::int AS clicks,
    ROUND((SUM(d."costMicros")/1e6)::numeric,2) AS spend_eur,
    SUM(d."sales7dCents")::int AS sales_c, SUM(d."orders7d")::int AS orders
  FROM "AmazonAdsDailyPerformance" d
  WHERE d."entityType"='AD_TARGET'`))
console.log('\n— GALE IT campaign-grain CTR/CVR over 30d (the reliable grain) —')
show(await q(`SELECT ROUND((100.0*SUM(d.clicks)/NULLIF(SUM(d.impressions),0))::numeric,3) AS ctr_pct,
    ROUND((100.0*SUM(d."orders7d")/NULLIF(SUM(d.clicks),0))::numeric,2) AS cvr_pct,
    ROUND((SUM(d."costMicros")/1e6/NULLIF(SUM(d.clicks),0))::numeric,2) AS cpc_eur
  FROM "AmazonAdsDailyPerformance" d JOIN "Campaign" c ON c."externalCampaignId"=d."entityId"
  WHERE d."entityType"='CAMPAIGN' AND UPPER(c.name) LIKE '%GALE%' AND c.marketplace='IT'
    AND d.date > now() - interval '30 days'`))
await p.$disconnect(); process.exit(0)
