const { default: prisma } = await import('../src/db.js')
const r = await prisma.$queryRawUnsafe<Array<Record<string,unknown>>>(`
  SELECT "marketplace", COUNT(*)::bigint AS n, SUM(CASE WHEN status='ENABLED' THEN 1 ELSE 0 END)::bigint AS enabled
  FROM "Campaign" GROUP BY 1 ORDER BY 2 DESC`)
for (const x of r) console.log(`  ${String(x.marketplace).padEnd(6)} total=${Number(x.n as bigint)}  enabled=${Number(x.enabled as bigint)}`)
const hz = await prisma.$queryRawUnsafe<Array<Record<string,unknown>>>(`
  SELECT h."marketplace", COUNT(DISTINCT h."localEntityId")::bigint AS campaigns_with_hourly
  FROM "AmazonAdsHourlyPerformance" h WHERE h."entityType"='CAMPAIGN' AND h."date" >= CURRENT_DATE - 7 GROUP BY 1 ORDER BY 2 DESC`)
console.log('  --- hourly coverage by marketplace (7d) ---')
for (const x of hz) console.log(`  ${String(x.marketplace).padEnd(6)} ${Number(x.campaigns_with_hourly as bigint)}`)
await prisma.$disconnect()
