/** ACR.2.2 — why does the hourly default-bid stamp not reach the 925? READ-ONLY. */
import { resolve } from 'path'
import { config } from 'dotenv'
config()
config({ path: resolve(new URL('.', import.meta.url).pathname, '../../../.env') })
const { PrismaClient } = await import('@prisma/client')
const p = new PrismaClient()
const q = <T = Record<string, unknown>>(s: string) => p.$queryRawUnsafe<T[]>(s)
const n = (v: unknown) => (typeof v === 'bigint' ? Number(v) : v)
const show = (rows: Record<string, unknown>[], max = 20) => rows.length
  ? rows.slice(0, max).forEach((r) => console.log('  ' + Object.entries(r).map(([k, v]) => `${k}=${n(v)}`).join('  ')))
  : console.log('  (none)')
const h = (s: string) => console.log(`\n── ${s} ──`)

h('the stamp predicate, term by term, over ALL zero-bid ENABLED targets (every market)')
show(await q(`
  SELECT COUNT(*)::int AS zero_bid_enabled,
         COUNT(*) FILTER (WHERE t."isNegative" IS NULL)::int AS is_negative_null,
         COUNT(*) FILTER (WHERE t."isNegative" = false)::int AS is_negative_false,
         COUNT(*) FILTER (WHERE t."isNegative" = true)::int AS is_negative_true,
         COUNT(*) FILTER (WHERE ag."defaultBidCents" IS NULL)::int AS group_default_null,
         COUNT(*) FILTER (WHERE COALESCE(ag."defaultBidCents",0) > 0)::int AS group_default_positive
  FROM "AdTarget" t JOIN "AdGroup" ag ON ag.id = t."adGroupId"
  WHERE t.status='ENABLED' AND COALESCE(t."bidCents",0) <= 0`))

h('how many rows would the stamp UPDATE right now, exactly as written?')
show(await q(`
  SELECT COUNT(*)::int AS would_update
  FROM "AdTarget" t JOIN "AdGroup" ag ON ag.id = t."adGroupId"
  WHERE t."isNegative" = false AND t.status = 'ENABLED'
    AND t."bidCents" <= 0 AND ag."defaultBidCents" > 0`))

h('and how many if isNegative NULL were treated as not-negative?')
show(await q(`
  SELECT COUNT(*)::int AS would_update_with_coalesce
  FROM "AdTarget" t JOIN "AdGroup" ag ON ag.id = t."adGroupId"
  WHERE COALESCE(t."isNegative", false) = false AND t.status = 'ENABLED'
    AND t."bidCents" <= 0 AND ag."defaultBidCents" > 0`))

h('did the resync cron actually finish? last runs')
show(await q(`SELECT status, "startedAt"::text AS started, LEFT(COALESCE("outputSummary"::text,''),160) AS summary,
    LEFT(COALESCE("errorMessage",''),120) AS err
  FROM "CronRun" WHERE "jobName"='ads-keyword-bid-resync' ORDER BY "startedAt" DESC LIMIT 6`))

await p.$disconnect()
