const { default: prisma } = await import('../src/db.js')
const q = <T,>(s: string) => prisma.$queryRawUnsafe<T[]>(s)
const j = (v: unknown) => (v instanceof Date ? v.toISOString() : typeof v === 'bigint' ? Number(v) : String(v))
const t = (r: Array<Record<string, unknown>>) => r.forEach(x => console.log('   ' + Object.entries(x).map(([k, v]) => `${k}=${j(v)}`).join('  ')))
console.log('=== lastSyncStatus across all campaigns ===')
t(await q(`SELECT "lastSyncStatus", COUNT(*)::bigint AS n, SUM(CASE WHEN status='ENABLED' THEN 1 ELSE 0 END)::bigint AS enabled FROM "Campaign" GROUP BY 1 ORDER BY 2 DESC`))
console.log('\n=== campaigns whose stored budget disagrees with Amazon last reported ===')
t(await q(`WITH latest AS (
   SELECT DISTINCT ON ("localEntityId") "localEntityId" AS cid, "campaignBudgetCents", "date"
   FROM "AmazonAdsDailyPerformance"
   WHERE "entityType"='CAMPAIGN' AND "localEntityId" IS NOT NULL AND "campaignBudgetCents" IS NOT NULL
   ORDER BY "localEntityId", "date" DESC)
 SELECT COUNT(*)::bigint AS comparable,
   COUNT(*) FILTER (WHERE ROUND(c."dailyBudget"*100) <> l."campaignBudgetCents")::bigint AS disagree,
   COUNT(*) FILTER (WHERE ROUND(c."dailyBudget"*100) <> l."campaignBudgetCents" AND c.status='ENABLED')::bigint AS disagree_enabled
 FROM latest l JOIN "Campaign" c ON c.id=l.cid`))
console.log('\n=== the disagreements ===')
t(await q(`WITH latest AS (
   SELECT DISTINCT ON ("localEntityId") "localEntityId" AS cid, "campaignBudgetCents", "date"
   FROM "AmazonAdsDailyPerformance"
   WHERE "entityType"='CAMPAIGN' AND "localEntityId" IS NOT NULL AND "campaignBudgetCents" IS NOT NULL
   ORDER BY "localEntityId", "date" DESC)
 SELECT LEFT(c.name,30) AS name, c.status, c."lastSyncStatus" AS sync, c."dailyBudget"::text AS ours,
   (l."campaignBudgetCents"/100.0)::text AS amazon, l."date"::text AS as_of
 FROM latest l JOIN "Campaign" c ON c.id=l.cid
 WHERE ROUND(c."dailyBudget"*100) <> l."campaignBudgetCents" ORDER BY c.status, 1 LIMIT 12`))
await prisma.$disconnect()
