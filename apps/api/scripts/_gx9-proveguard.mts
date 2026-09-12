/** READ-ONLY. Prove the idle-vs-broken clause is what suppresses the ES days — a guard that
 *  passes for the wrong reason is worse than no guard. Runs the SAME query twice, once with
 *  has_enabled forced TRUE, and diffs. */
import '../src/env.js'
const { default: prisma } = await import('../src/db.js')
const build = (force: boolean) => `
  WITH active AS (
    SELECT c."profileId", c."marketplace",
      ${force ? 'TRUE' : `EXISTS (SELECT 1 FROM "Campaign" k WHERE k."marketplace"=c."marketplace" AND k."status"::text='ENABLED')`} AS has_enabled
    FROM "AmazonAdsConnection" c WHERE c."isActive"=true
      AND EXISTS (SELECT 1 FROM "Campaign" k WHERE k."marketplace"=c."marketplace")),
  lastspend AS (
    SELECT "marketplace", MAX("date") AS last_spend FROM "AmazonAdsDailyPerformance"
    WHERE "entityType"='CAMPAIGN' AND "costMicros">0 AND "reportRunId" IS DISTINCT FROM 'ams-stream' GROUP BY 1),
  days AS (SELECT generate_series(CURRENT_DATE - 15, CURRENT_DATE - 2, '1 day')::date AS day),
  perf AS (
    SELECT p."profileId", p."date",
      COUNT(*) FILTER (WHERE p."entityType"='CAMPAIGN') AS campaign_rows
    FROM "AmazonAdsDailyPerformance" p
    WHERE p."date" >= CURRENT_DATE - 15 AND p."reportRunId" IS DISTINCT FROM 'ams-stream' GROUP BY 1,2)
  SELECT a."marketplace" AS mkt, d.day::text AS day
  FROM active a CROSS JOIN days d
  LEFT JOIN perf f ON f."profileId"=a."profileId" AND f."date"=d.day
  LEFT JOIN lastspend ls ON ls."marketplace"=a."marketplace"
  WHERE (a.has_enabled OR d.day <= COALESCE(ls.last_spend, d.day - 1))
    AND COALESCE(f.campaign_rows,0)=0
  ORDER BY 1,2`
const guarded = await prisma.$queryRawUnsafe<Record<string,unknown>[]>(build(false))
const forced  = await prisma.$queryRawUnsafe<Record<string,unknown>[]>(build(true))
const key = (r: Record<string,unknown>) => `${r.mkt} ${r.day}`
const suppressed = forced.filter(f => !guarded.some(g => key(g) === key(f)))
console.log(`with the guard      : ${guarded.length} whole-day gaps`)
console.log(`with has_enabled ON : ${forced.length} whole-day gaps`)
console.log(`SUPPRESSED BY THE GUARD (${suppressed.length}): ${suppressed.map(key).join(', ') || '(none)'}`)
console.log(suppressed.length > 0
  ? '✓ the clause has teeth — it removes days, and only days after an idle market last spent'
  : '✗ the clause changed nothing here; it would pass for the wrong reason')
await prisma.$disconnect()
