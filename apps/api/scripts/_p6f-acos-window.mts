/** READ-ONLY. Is the >100% ACoS population really empty on the page's DEFAULT window? */
const { default: prisma } = await import('../src/db.js')
const q = <T,>(s: string) => prisma.$queryRawUnsafe<T[]>(s)
for (const days of [7, 14, 30]) {
  const r = await q<Record<string, unknown>>(`
    WITH a AS (
      SELECT "localEntityId" AS cid, SUM("costMicros")/1e6 AS spend, SUM("sales7dCents")/100.0 AS sales
      FROM "AmazonAdsDailyPerformance"
      WHERE "entityType"='CAMPAIGN' AND "localEntityId" IS NOT NULL AND "date" >= CURRENT_DATE - ${days}
      GROUP BY 1)
    SELECT COUNT(*) FILTER (WHERE sales > 0 AND spend/sales > 1)::bigint AS over_100pct,
           COUNT(*) FILTER (WHERE sales > 0 AND spend/sales > 0.5)::bigint AS over_50pct
    FROM a`)
  console.log(`  last ${String(days).padStart(2)}d: ACoS>100% = ${Number(r[0].over_100pct as bigint)} · ACoS>50% = ${Number(r[0].over_50pct as bigint)}`)
}
const worst = await q<Record<string, unknown>>(`
  WITH a AS (
    SELECT "localEntityId" AS cid, SUM("costMicros")/1e6 AS spend, SUM("sales7dCents")/100.0 AS sales
    FROM "AmazonAdsDailyPerformance"
    WHERE "entityType"='CAMPAIGN' AND "localEntityId" IS NOT NULL AND "date" >= CURRENT_DATE - 30
    GROUP BY 1)
  SELECT LEFT(c.name,30) AS name, ROUND((100*a.spend/NULLIF(a.sales,0))::numeric,1) AS acos_pct
  FROM a JOIN "Campaign" c ON c.id=a.cid WHERE a.sales > 0 AND a.spend/a.sales > 1 ORDER BY 2 DESC`)
console.log('\n  campaigns over 100% on the 30-day window:')
for (const w of worst) console.log(`    ${String(w.name).padEnd(32)} ${w.acos_pct}%`)
await prisma.$disconnect()
