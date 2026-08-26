/** READ-ONLY. ADM-H part 5 — is the HOURLY grain populated? (ActBid/OOB hours, current util) */
const { default: prisma } = await import('../src/db.js')
const r = await prisma.$queryRawUnsafe<Array<Record<string, unknown>>>(`
  SELECT "entityType", COUNT(*)::bigint AS rows, COUNT(DISTINCT "entityId")::bigint AS entities,
         MIN("date")::text AS first_day, MAX("date")::text AS last_day,
         COUNT(DISTINCT "date")::bigint AS days
  FROM "AmazonAdsHourlyPerformance" GROUP BY "entityType" ORDER BY 2 DESC
`)
console.log('== AmazonAdsHourlyPerformance =='); console.table(r.map(x => Object.fromEntries(Object.entries(x).map(([k, v]) => [k, typeof v === 'bigint' ? Number(v) : v]))))
const last7 = new Date(Date.now() - 6 * 864e5).toISOString().slice(0, 10)
const c = await prisma.$queryRawUnsafe<Array<Record<string, unknown>>>(`
  SELECT COUNT(DISTINCT "localEntityId")::bigint AS campaigns_with_hourly,
         COUNT(DISTINCT ("localEntityId" || '|' || "date"::text))::bigint AS campaign_days,
         COUNT(*)::bigint AS rows
  FROM "AmazonAdsHourlyPerformance"
  WHERE "entityType"='CAMPAIGN' AND "date" >= '${last7}'::date AND "localEntityId" IS NOT NULL
`)
console.log(`\n== hourly CAMPAIGN grain, last 7d (since ${last7}) ==`)
for (const [k, v] of Object.entries(c[0] ?? {})) console.log(`  ${k.padEnd(24)} ${Number(v as bigint)}`)
// hours-per-campaign-day: the raw material for ActBid / OOB hours
const h = await prisma.$queryRawUnsafe<Array<Record<string, unknown>>>(`
  SELECT hours_with_rows, COUNT(*)::bigint AS campaign_days FROM (
    SELECT "localEntityId","date", COUNT(DISTINCT "hour")::int AS hours_with_rows
    FROM "AmazonAdsHourlyPerformance"
    WHERE "entityType"='CAMPAIGN' AND "date" >= '${last7}'::date AND "localEntityId" IS NOT NULL
    GROUP BY 1,2) t GROUP BY 1 ORDER BY 1 DESC LIMIT 10
`)
console.log(`\n  distinct hours present per campaign-day (24 = full coverage):`)
for (const x of h) console.log(`    ${String(x.hours_with_rows).padStart(2)}h  ->  ${Number(x.campaign_days as bigint)} campaign-days`)
await prisma.$disconnect()
