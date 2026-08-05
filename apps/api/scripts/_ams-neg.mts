import prisma from '../src/db.js'
const q = (s: string) => prisma.$queryRawUnsafe<any[]>(s)
const L: string[] = []
const neg = await q(`
  SELECT "marketplace","date"::text AS day,"hour","entityType","entityId",
         "impressions","clicks","costMicros"::text AS cost_micros,
         "reportedAt"::text AS reported, "createdAt"::text AS created
  FROM "AmazonAdsHourlyPerformance"
  WHERE "impressions" < 0 OR "clicks" < 0
  ORDER BY "date" DESC, "hour" LIMIT 12`)
L.push('=== raw negative rows ===\n' + neg.map((r) =>
  `${r.marketplace} ${r.day} h${r.hour} ${r.entityType} ${r.entityId} impr=${r.impressions} clicks=${r.clicks} cost=${r.cost_micros} reported=${r.reported}`).join('\n'))
const spread = await q(`
  SELECT COUNT(*)::int AS neg_rows,
         COUNT(DISTINCT "date")::int AS days,
         MIN("impressions")::int AS worst,
         SUM("impressions")::int AS sum_impr
  FROM "AmazonAdsHourlyPerformance" WHERE "impressions" < 0`)
L.push('\n=== scope ===\n' + JSON.stringify(spread[0]))
// Is the SAME entity/hour present more than once across dates? (dupe vs delta)
const hr = await q(`
  SELECT "date"::text AS day, "hour", COUNT(*)::int AS rows,
         SUM("impressions")::int AS impr
  FROM "AmazonAdsHourlyPerformance"
  WHERE "marketplace"='IT' AND "date"='2026-08-02'
  GROUP BY 1,2 ORDER BY 2`)
L.push('\n=== IT 2026-08-02 by hour ===\n' + hr.map((r) => `h${r.hour}: rows=${r.rows} impr=${r.impr}`).join('\n'))
console.error(L.join('\n'))
process.exit(0)
