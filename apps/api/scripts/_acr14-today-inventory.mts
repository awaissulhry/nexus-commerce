/**
 * ACR.1.4 — what would actually be ON a Today board right now? READ-ONLY.
 *
 * Building an exception board against imagined exceptions is how you ship a page that is
 * empty in prod and full in a demo. Measure the candidate sources first, then build only
 * the ones that carry real rows.
 */
import { resolve } from 'path'
import { config } from 'dotenv'
config()
config({ path: resolve(new URL('.', import.meta.url).pathname, '../../../.env') })
const { PrismaClient } = await import('@prisma/client')
const p = new PrismaClient()
const q = <T = Record<string, unknown>>(s: string) => p.$queryRawUnsafe<T[]>(s)
const n = (v: unknown) => (typeof v === 'bigint' ? Number(v) : v)
const show = (rows: Record<string, unknown>[], max = 12) => rows.length
  ? rows.slice(0, max).forEach((r) => console.log('  ' + Object.entries(r).map(([k, v]) => `${k}=${String(n(v)).slice(0, 90)}`).join('  ')))
  : console.log('  (none)')
const h = (s: string) => console.log(`\n${'─'.repeat(78)}\n${s}\n${'─'.repeat(78)}`)

h('1. cron failures, last 24h — the "an engine is broken" row')
show(await q(`SELECT "jobName", COUNT(*)::int AS runs,
        COUNT(*) FILTER (WHERE status='FAILED')::int AS failed,
        MAX("startedAt")::text AS last
     FROM "CronRun" WHERE "startedAt" > now() - interval '24 hours'
     GROUP BY 1 HAVING COUNT(*) FILTER (WHERE status='FAILED') > 0
     ORDER BY failed DESC`), 15)

h('2. ads writes stuck in the outbound queue — the "a change never landed" row')
show(await q(`SELECT "syncStatus", COUNT(*)::int AS rows, MAX("updatedAt")::text AS newest
     FROM "OutboundSyncQueue" WHERE "syncType" ILIKE '%AD%' GROUP BY 1 ORDER BY 2 DESC`))
show(await q(`SELECT "syncType", "syncStatus", COUNT(*)::int AS rows FROM "OutboundSyncQueue"
     WHERE "syncType" ILIKE '%AD%' GROUP BY 1,2 ORDER BY 3 DESC`), 10)
show(await q(`SELECT COUNT(*)::int AS ads_mutations_pending FROM "AdMutation" WHERE state='PENDING'`))
show(await q(`SELECT state, COUNT(*)::int AS rows FROM "AdMutation"
     WHERE "createdAt" > now() - interval '7 days' GROUP BY 1 ORDER BY 2 DESC`))

h('3. proposals waiting on a human — the "automation asked and got no answer" row')
show(await q(`SELECT status, COUNT(*)::int AS rows, MIN("createdAt")::text AS oldest
     FROM "AdsRuleSuggestion" GROUP BY 1 ORDER BY 2 DESC`))

h('4. wasted spend — terms with clicks and no sales, last 30d (AD_TARGET grain)')
show(await q(`SELECT COUNT(*)::int AS targets,
        ROUND((SUM(spend)/100.0)::numeric,2) AS wasted_eur
     FROM (
       SELECT d."entityId", SUM(d."costMicros")/10000 AS spend, SUM(d.clicks) AS clicks, SUM(d."sales7dCents") AS sales
       FROM "AmazonAdsDailyPerformance" d
       WHERE d."entityType"='AD_TARGET' AND d.date > now() - interval '30 days'
       GROUP BY 1 HAVING SUM(d.clicks) >= 10 AND SUM(d."sales7dCents") = 0
     ) x`))

h('5. campaigns that are not delivering — the "you are paying for nothing" row')
show(await q(`SELECT "deliveryStatus", COUNT(*)::int AS campaigns
     FROM "Campaign" WHERE status='ENABLED' GROUP BY 1 ORDER BY 2 DESC`))

h('6. unbounded authority — campaigns automation may write to with no bid ceiling')
show(await q(`SELECT COUNT(*)::int AS allowlisted,
        COUNT(*) FILTER (WHERE "maxBidCents" IS NULL)::int AS no_max_bid,
        COUNT(*) FILTER (WHERE "minBidCents" IS NULL)::int AS no_min_bid
     FROM "Campaign" WHERE "liveBidWritesEnabled" = true`))

h('7. all-out rank windows — the open "no CPC ceiling" issue, is it still live?')
show(await q(`SELECT s.id, c.name, s.enabled, s."defaultTargetKey"
     FROM "AdSchedule" s JOIN "Campaign" c ON c.id = s."campaignId"
     WHERE s.enabled = true AND s.windows::text ILIKE '%allOut%' LIMIT 10`))
show(await q(`SELECT COUNT(*)::int AS enabled_schedules,
        COUNT(*) FILTER (WHERE windows::text ILIKE '%allOut%')::int AS with_allout
     FROM "AdSchedule" WHERE enabled = true`))

h('8. rank targets with no CPC ceiling')
show(await q(`SELECT COUNT(*)::int AS targets,
        COUNT(*) FILTER (WHERE "maxCpcCents" IS NULL)::int AS no_ceiling,
        COUNT(*) FILTER (WHERE "allOut" = true)::int AS all_out
     FROM "RankTarget"`).catch(() => [{ error: 'RankTarget shape differs' }]))

h('9. outbound API failures, last 24h — the ads client now logs these')
show(await q(`SELECT operation, COUNT(*)::int AS calls,
        COUNT(*) FILTER (WHERE success = false)::int AS failed
     FROM "OutboundApiCallLog"
     WHERE "createdAt" > now() - interval '24 hours' AND operation LIKE 'ads %'
     GROUP BY 1 ORDER BY failed DESC, calls DESC`), 15)

await p.$disconnect()
console.log('\nDone — read-only.\n')
