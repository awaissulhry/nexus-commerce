/** READ-ONLY. GX.4 — same reconciliation for AD_TARGET (targeting ingest began 2026-07-05). */
import '../src/env.js'
const { default: prisma } = await import('../src/db.js')
const r = await prisma.$queryRawUnsafe<Record<string,unknown>[]>(`
  WITH c AS (SELECT marketplace, date, SUM("costMicros")/1e6 AS spend FROM "AmazonAdsDailyPerformance"
             WHERE "entityType"='CAMPAIGN' AND "reportRunId" IS DISTINCT FROM 'ams-stream' AND date >= '2026-07-05' GROUP BY 1,2),
       t AS (SELECT marketplace, date, SUM("costMicros")/1e6 AS spend FROM "AmazonAdsDailyPerformance"
             WHERE "entityType"='AD_TARGET' AND "reportRunId" IS DISTINCT FROM 'ams-stream' AND date >= '2026-07-05' GROUP BY 1,2)
  SELECT c.marketplace, COUNT(*)::int AS days,
    COUNT(*) FILTER (WHERE COALESCE(t.spend,0) >= c.spend*0.99)::int AS days_full,
    COUNT(*) FILTER (WHERE COALESCE(t.spend,0) = 0 AND c.spend > 0)::int AS days_zero,
    ROUND((100*SUM(COALESCE(t.spend,0))/NULLIF(SUM(c.spend),0))::numeric,1)::text AS pct,
    ROUND(SUM(c.spend - COALESCE(t.spend,0))::numeric,2)::text AS missing_eur
  FROM c LEFT JOIN t ON t.date=c.date AND t.marketplace=c.marketplace
  WHERE c.spend > 0 GROUP BY 1 ORDER BY 6 DESC`)
console.log('AD_TARGET vs CAMPAIGN since targeting ingest began:')
for (const x of r) console.log(`  ${x.marketplace}  days ${String(x.days).padStart(3)}  full ${String(x.days_full).padStart(3)}  zero ${String(x.days_zero).padStart(3)}  covered ${String(x.pct).padStart(6)}%  missing €${x.missing_eur}`)
await prisma.$disconnect()
