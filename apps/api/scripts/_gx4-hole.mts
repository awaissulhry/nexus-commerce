/** READ-ONLY. GX.3 — the campaign→product gap is NOT structural: recent days reconcile at 100%.
 *  So which days are short, and by how much? `ads-report-gapfill` only chases days with ZERO rows,
 *  so a PARTIALLY ingested day is invisible to it. */
import '../src/env.js'
const { default: prisma } = await import('../src/db.js')
const q = (s: string) => prisma.$queryRawUnsafe<Record<string, unknown>[]>(s)
const show = (t: string, r: Record<string, unknown>[], w = 18) => {
  console.log(`\n== ${t} ==`)
  if (!r.length) return console.log('  (no rows)')
  const cols = Object.keys(r[0])
  console.log('  ' + cols.map(c => c.padEnd(w)).join(''))
  for (const row of r) console.log('  ' + cols.map(c => String(row[c] ?? '—').slice(0, w-1).padEnd(w)).join(''))
}
const AMS = `"reportRunId" IS DISTINCT FROM 'ams-stream'`
const day = (grain: string) => `
  SELECT marketplace, date, SUM("costMicros")/1e6 AS spend
  FROM "AmazonAdsDailyPerformance" WHERE "entityType"='${grain}' AND ${AMS} GROUP BY 1,2`
show('daily reconciliation, PRODUCT_AD vs CAMPAIGN, by month × market', await q(`
  WITH c AS (${day('CAMPAIGN')}), p AS (${day('PRODUCT_AD')})
  SELECT TO_CHAR(c.date,'YYYY-MM') AS month, c.marketplace,
    COUNT(*)::int AS days,
    COUNT(*) FILTER (WHERE COALESCE(p.spend,0) >= c.spend * 0.99)::int AS days_full,
    COUNT(*) FILTER (WHERE COALESCE(p.spend,0) = 0 AND c.spend > 0)::int AS days_zero,
    COUNT(*) FILTER (WHERE COALESCE(p.spend,0) > 0 AND COALESCE(p.spend,0) < c.spend * 0.99)::int AS days_partial,
    ROUND(SUM(c.spend - COALESCE(p.spend,0))::numeric,2)::text AS missing_eur
  FROM c LEFT JOIN p ON p.date=c.date AND p.marketplace=c.marketplace
  WHERE c.spend > 0 GROUP BY 1,2 ORDER BY 1 DESC, 2`))
show('TOTAL unattributed spend by market (all time)', await q(`
  WITH c AS (${day('CAMPAIGN')}), p AS (${day('PRODUCT_AD')})
  SELECT c.marketplace,
    ROUND(SUM(c.spend)::numeric,2)::text AS campaign_spend,
    ROUND(SUM(COALESCE(p.spend,0))::numeric,2)::text AS product_spend,
    ROUND((100*SUM(COALESCE(p.spend,0))/NULLIF(SUM(c.spend),0))::numeric,1)::text AS pct,
    MIN(c.date) FILTER (WHERE COALESCE(p.spend,0) < c.spend*0.99)::text AS first_short,
    MAX(c.date) FILTER (WHERE COALESCE(p.spend,0) < c.spend*0.99)::text AS last_short
  FROM c LEFT JOIN p ON p.date=c.date AND p.marketplace=c.marketplace
  WHERE c.spend > 0 GROUP BY 1 ORDER BY 2 DESC`))
await prisma.$disconnect()
