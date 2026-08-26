/** READ-ONLY. ADM-H P2 — can Average Budget Utilization be sourced honestly, and does the
 *  externalCampaignId fallback contribute any rows the localEntityId match misses? */
const { default: prisma } = await import('../src/db.js')
const s = new Date(Date.now() - 6 * 864e5).toISOString().slice(0, 10)
const fb = await prisma.$queryRawUnsafe<Array<Record<string, unknown>>>(`
  SELECT COUNT(*)::bigint AS orphan_rows,
         COUNT(DISTINCT p."entityId")::bigint AS orphan_entities,
         COUNT(DISTINCT c.id)::bigint AS matchable_campaigns
  FROM "AmazonAdsDailyPerformance" p
  LEFT JOIN "Campaign" c ON c."externalCampaignId" = p."entityId"
  WHERE p."entityType"='CAMPAIGN' AND p."date" >= '${s}'::date AND p."localEntityId" IS NULL
`)
console.log('== rows in window with localEntityId NULL (the fallback bucket) ==')
for (const [k, v] of Object.entries(fb[0] ?? {})) console.log(`  ${k.padEnd(22)} ${Number(v as bigint)}`)

const u = await prisma.$queryRawUnsafe<Array<Record<string, unknown>>>(`
  WITH d AS (
    SELECT "localEntityId" AS cid, "date",
           SUM("costMicros")/10000.0        AS spend_cents,
           MAX("campaignBudgetCents")::int  AS budget_cents
    FROM "AmazonAdsDailyPerformance"
    WHERE "entityType"='CAMPAIGN' AND "date" >= '${s}'::date AND "localEntityId" IS NOT NULL
    GROUP BY 1,2
  )
  SELECT COUNT(*)::bigint AS campaigns,
         SUM(CASE WHEN days > 0 THEN 1 ELSE 0 END)::bigint AS measurable,
         ROUND(AVG(util)::numeric,4) AS mean_util,
         ROUND(MAX(util)::numeric,4) AS max_util
  FROM (
    SELECT cid,
           AVG(spend_cents / NULLIF(budget_cents,0)) AS util,
           COUNT(*) FILTER (WHERE budget_cents > 0)  AS days
    FROM d GROUP BY cid
  ) t
`)
console.log('\n== per-day ratio, then averaged (the honest form) ==')
for (const [k, v] of Object.entries(u[0] ?? {})) console.log(`  ${k.padEnd(22)} ${String(v)}`)

const sample = await prisma.$queryRawUnsafe<Array<Record<string, unknown>>>(`
  WITH d AS (
    SELECT "localEntityId" AS cid, "date",
           SUM("costMicros")/10000.0 AS spend_cents, MAX("campaignBudgetCents")::int AS budget_cents
    FROM "AmazonAdsDailyPerformance"
    WHERE "entityType"='CAMPAIGN' AND "date" >= '${s}'::date AND "localEntityId" IS NOT NULL
    GROUP BY 1,2
  )
  SELECT c.name,
         ROUND((AVG(d.spend_cents / NULLIF(d.budget_cents,0))*100)::numeric,1) AS avg_util_pct,
         COUNT(*) FILTER (WHERE d.budget_cents > 0) AS days,
         ROUND((SUM(d.spend_cents)/100)::numeric,2) AS spend_eur
  FROM d JOIN "Campaign" c ON c.id = d.cid
  GROUP BY c.name ORDER BY 4 DESC LIMIT 8
`)
console.log('\n== sample ==')
for (const r of sample) console.log(`  ${String(r.name).slice(0,42).padEnd(44)} avg util ${String(r.avg_util_pct).padStart(6)}%  over ${r.days}d  spend EUR${r.spend_eur}`)
await prisma.$disconnect()
