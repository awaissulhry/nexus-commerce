/**
 * ACR.1.2 — what evidence can a Levers engine drawer actually SHOW? READ-ONLY.
 *
 * The drawer promises "evidence samples" per engine. That needs a map from an engine key to
 * the rows it produced, and the only link is the actor string. Guessing that map is exactly
 * how the earlier passes in this programme went wrong, so this measures which actors exist,
 * on which tables, and in what volume — and the map is written from the output.
 */
import { resolve } from 'path'
import { config } from 'dotenv'
config()
config({ path: resolve(new URL('.', import.meta.url).pathname, '../../../.env') })
const { PrismaClient } = await import('@prisma/client')
const p = new PrismaClient()
const q = <T = Record<string, unknown>>(s: string) => p.$queryRawUnsafe<T[]>(s)
const n = (v: unknown) => (typeof v === 'bigint' ? Number(v) : v)
const show = (rows: Record<string, unknown>[], max = 40) => rows.length
  ? rows.slice(0, max).forEach((r) => console.log('  ' + Object.entries(r).map(([k, v]) => `${k}=${String(n(v)).slice(0, 60)}`).join('  ')))
  : console.log('  (none)')
const h = (s: string) => console.log(`\n${'─'.repeat(96)}\n${s}\n${'─'.repeat(96)}`)

h('1. AdvertisingActionLog — actor vocabulary, 30d')
show(await q(`
  SELECT COALESCE("userId",'(null)') AS actor, "actionType", COUNT(*)::int AS n,
         MAX("createdAt")::text AS last
  FROM "AdvertisingActionLog"
  WHERE "createdAt" > NOW() - INTERVAL '30 days'
  GROUP BY 1,2 ORDER BY n DESC LIMIT 40
`))

h('2. AdvertisingActionLog — actor PREFIX rollup (what an engine map would key on)')
show(await q(`
  SELECT CASE
           WHEN "userId" IS NULL THEN '(null)'
           WHEN "userId" LIKE 'automation:rank-defend-%' THEN 'automation:rank-defend-*'
           WHEN "userId" LIKE 'automation:rank-plan-%'   THEN 'automation:rank-plan-*'
           WHEN "userId" LIKE 'automation:rule-%'        THEN 'automation:rule-*'
           WHEN "userId" LIKE 'automation:%'             THEN "userId"
           ELSE '(human/other)' END AS actor_prefix,
         COUNT(*)::int AS n, MAX("createdAt")::text AS last
  FROM "AdvertisingActionLog"
  WHERE "createdAt" > NOW() - INTERVAL '30 days'
  GROUP BY 1 ORDER BY n DESC LIMIT 30
`))

h('3. CampaignBidHistory — changedBy vocabulary, 30d')
show(await q(`
  SELECT CASE
           WHEN "changedBy" IS NULL THEN '(null)'
           WHEN "changedBy" LIKE 'automation:rank-defend-%' THEN 'automation:rank-defend-*'
           WHEN "changedBy" LIKE 'automation:rank-plan-%'   THEN 'automation:rank-plan-*'
           WHEN "changedBy" LIKE 'automation:rule-%'        THEN 'automation:rule-*'
           WHEN "changedBy" LIKE 'automation:%'             THEN "changedBy"
           ELSE '(human/other)' END AS actor_prefix,
         COUNT(*)::int AS n, MAX("changedAt")::text AS last
  FROM "CampaignBidHistory"
  WHERE "changedAt" > NOW() - INTERVAL '30 days'
  GROUP BY 1 ORDER BY n DESC LIMIT 30
`))

h('4. CronRun — the 12 Levers engines: is there history to draw?')
show(await q(`
  SELECT "jobName", COUNT(*)::int AS runs,
         SUM(CASE WHEN status='FAILED' THEN 1 ELSE 0 END)::int AS failed,
         MAX("startedAt")::text AS last,
         SUM(CASE WHEN "triggeredBy"='manual' THEN 1 ELSE 0 END)::int AS manual
  FROM "CronRun"
  WHERE "startedAt" > NOW() - INTERVAL '14 days'
    AND "jobName" IN ('ad-rank-defend','ad-dayparting','ad-budget-enforce','budget-pool-rebalance',
                      'ads-auto-bid','ads-auto-harvest','ads-anomaly-guard','top-of-search-defense',
                      'tos-is-ingest','sqp-ingest','ads-structural-reconcile','drain-ads-sync')
  GROUP BY 1 ORDER BY runs DESC
`))

h('5. Do any CronRun rows carry an outputSummary worth showing? (last per job)')
show(await q(`
  SELECT DISTINCT ON ("jobName") "jobName", status, "triggeredBy",
         COALESCE("outputSummary", "errorMessage", '(none)') AS summary
  FROM "CronRun"
  WHERE "jobName" IN ('ad-rank-defend','ad-dayparting','ad-budget-enforce','budget-pool-rebalance',
                      'ads-auto-bid','ads-auto-harvest','ads-anomaly-guard','top-of-search-defense',
                      'tos-is-ingest','sqp-ingest','ads-structural-reconcile','drain-ads-sync')
  ORDER BY "jobName", "startedAt" DESC
`))

h('6. Authority pins — the new columns, and the current guardrail coverage they sit beside')
show(await q(`
  SELECT COUNT(*)::int AS campaigns,
         SUM(CASE WHEN "liveBidWritesEnabled" THEN 1 ELSE 0 END)::int AS allowlisted,
         SUM(CASE WHEN "minBidCents" IS NOT NULL THEN 1 ELSE 0 END)::int AS with_min,
         SUM(CASE WHEN "maxBidCents" IS NOT NULL THEN 1 ELSE 0 END)::int AS with_max,
         SUM(CASE WHEN "pinPlacement" OR "pinBids" OR "pinBudget" THEN 1 ELSE 0 END)::int AS pinned
  FROM "Campaign"
`))

h('7. Rules bound to a campaign (the Ad Manager Automation column\'s third input)')
show(await q(`
  SELECT COALESCE("scopeCampaignId",'(unbound)') AS scope_campaign, COUNT(*)::int AS rules
  FROM "AutomationRule" WHERE domain='advertising'
  GROUP BY 1 ORDER BY rules DESC LIMIT 12
`))

await p.$disconnect()
