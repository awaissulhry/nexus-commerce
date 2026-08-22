import '../src/env.js'
const { default: prisma } = await import('../src/db.js')
// The population a "ACoS <= x -> raise bid" Bid rule would wrongly match: spend, but no sales.
// Bid's trigger window is 14 settled days (TRIGGER_WINDOW.KEYWORD_HIGH_ACOS), minus 2 provisional.
const r = await prisma.$queryRawUnsafe<any[]>(`
  WITH perf AS (
    SELECT p."localEntityId" id,
           SUM(p."costMicros")/10000.0 AS spend_cents,
           SUM(p."sales7dCents")       AS sales_cents
    FROM "AmazonAdsDailyPerformance" p
    WHERE p."entityType"='AD_TARGET'
      AND p."date" >= (now()::date - interval '16 days') AND p."date" <= (now()::date - interval '2 days')
    GROUP BY 1)
  SELECT count(*)::int measured_targets,
         count(*) FILTER (WHERE perf.spend_cents > 0 AND perf.sales_cents = 0)::int spend_no_sales,
         count(*) FILTER (WHERE perf.spend_cents > 0 AND perf.sales_cents > 0)::int spend_with_sales,
         count(*) FILTER (WHERE perf.spend_cents > 0 AND perf.sales_cents = 0 AND c."liveBidWritesEnabled")::int spend_no_sales_writable,
         COALESCE(SUM(perf.spend_cents) FILTER (WHERE perf.spend_cents > 0 AND perf.sales_cents = 0),0)::int wasted_cents
  FROM perf
  JOIN "AdTarget" t ON t.id = perf.id
  JOIN "AdGroup" g ON g.id = t."adGroupId"
  JOIN "Campaign" c ON c.id = g."campaignId"
  WHERE t.kind='KEYWORD' AND t."isNegative"=false`)
console.log('===JSON===' + JSON.stringify(r[0], (_k,v)=>typeof v==='bigint'?Number(v):v, 1))
await prisma.$disconnect()
