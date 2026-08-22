/** READ-ONLY. What the double-count is doing to the numbers on screen right now. */
const { default: prisma } = await import('../src/db.js')
const q = <T,>(s: string) => prisma.$queryRawUnsafe<T[]>(s)
const j = (v: unknown) => (typeof v === 'bigint' ? Number(v) : String(v))
const t = (r: Array<Record<string, unknown>>) => r.forEach(x => console.log('   ' + Object.entries(x).map(([k, v]) => `${k}=${j(v)}`).join('  ')))
console.log('=== last 30 days, SP campaigns: what the grid shows vs what is true ===')
t(await q(`SELECT
   ROUND((SUM("sales7dCents" + COALESCE("sales14dCents",0))/100.0)::numeric,2) AS shown_sales_eur,
   ROUND((SUM("sales7dCents")/100.0)::numeric,2)                               AS true_sp_sales_eur,
   ROUND((SUM(COALESCE("sales14dCents",0))/100.0)::numeric,2)                  AS inflation_eur,
   ROUND((SUM("costMicros")/1e6)::numeric,2)                                   AS spend_eur
 FROM "AmazonAdsDailyPerformance"
 WHERE "entityType"='CAMPAIGN' AND "adProduct"='SPONSORED_PRODUCTS' AND "date" >= CURRENT_DATE - 30`))
console.log('\n=== the campaigns whose ACoS is most distorted in that window ===')
t(await q(`WITH a AS (
   SELECT "localEntityId" AS cid, SUM("costMicros")/1e6 AS spend,
     SUM("sales7dCents")/100.0 AS truth, SUM("sales7dCents" + COALESCE("sales14dCents",0))/100.0 AS shown
   FROM "AmazonAdsDailyPerformance"
   WHERE "entityType"='CAMPAIGN' AND "adProduct"='SPONSORED_PRODUCTS' AND "date" >= CURRENT_DATE - 30 AND "localEntityId" IS NOT NULL
   GROUP BY 1 HAVING SUM(COALESCE("sales14dCents",0)) > 0)
 SELECT LEFT(c.name,28) AS name,
   ROUND((100*a.spend/NULLIF(a.shown,0))::numeric,1) AS acos_shown_pct,
   ROUND((100*a.spend/NULLIF(a.truth,0))::numeric,1) AS acos_true_pct,
   ROUND(a.shown::numeric,2) AS sales_shown, ROUND(a.truth::numeric,2) AS sales_true
 FROM a JOIN "Campaign" c ON c.id=a.cid ORDER BY (a.shown-a.truth) DESC LIMIT 8`))
await prisma.$disconnect()
