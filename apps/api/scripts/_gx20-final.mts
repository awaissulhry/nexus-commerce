import '../src/env.js'
const { default: prisma } = await import('../src/db.js')
const r = await prisma.$queryRawUnsafe<Record<string,unknown>[]>(`
  WITH c AS (SELECT marketplace, date, SUM("costMicros")/1e6 AS spend FROM "AmazonAdsDailyPerformance"
             WHERE "entityType"='CAMPAIGN' AND "reportRunId" IS DISTINCT FROM 'ams-stream' AND date >= '2026-05-30' GROUP BY 1,2),
       p AS (SELECT marketplace, date, SUM("costMicros")/1e6 AS spend FROM "AmazonAdsDailyPerformance"
             WHERE "entityType"='PRODUCT_AD' AND "reportRunId" IS DISTINCT FROM 'ams-stream' AND date >= '2026-05-30' GROUP BY 1,2)
  SELECT c.marketplace,
    COUNT(*) FILTER (WHERE COALESCE(p.spend,0)=0 AND c.spend>0)::int AS zero_days,
    ROUND((100*SUM(COALESCE(p.spend,0))/NULLIF(SUM(c.spend),0))::numeric,1)::text AS pct_covered,
    ROUND(SUM(c.spend - COALESCE(p.spend,0))::numeric,2)::text AS still_missing
  FROM c LEFT JOIN p ON p.date=c.date AND p.marketplace=c.marketplace
  WHERE c.spend>0 GROUP BY 1 ORDER BY 1`)
for (const x of r) console.log(`  ${x.marketplace}  zero-days ${String(x.zero_days).padStart(2)}  covered ${String(x.pct_covered).padStart(6)}%  still missing €${x.still_missing}`)
await prisma.$disconnect()
