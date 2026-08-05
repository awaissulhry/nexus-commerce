/**
 * ACR.0.7b — what IS this account's normal action rate? READ-ONLY.
 *
 * The breaker tripped at 264 actions/hour against a 250 limit and halted the account.
 * Before raising the limit, measure what normal looks like — a threshold picked to make
 * today's alert go away is how you end up with a breaker that never fires when it matters.
 *
 * The guard counts `AutomationRuleExecution` rows with status SUCCESS|PARTIAL for
 * advertising rules in the trailing hour (ads-anomaly-guard.service.ts). Note this counts
 * RULE executions only — rank-defend's mutations are not in it, which is worth confirming
 * rather than assuming, because it changes what "264 actions" actually described.
 *
 * Usage: cd apps/api && npx tsx scripts/_acr07-breaker-rate.mts
 */
import { resolve } from 'path'
import { config } from 'dotenv'
config()
config({ path: resolve(new URL('.', import.meta.url).pathname, '../../../.env') })

const { PrismaClient } = await import('@prisma/client')
const p = new PrismaClient()
const q = <T = Record<string, unknown>>(sql: string) => p.$queryRawUnsafe<T[]>(sql)
const n = (v: unknown) => (typeof v === 'bigint' ? Number(v) : v)
const show = (rows: Record<string, unknown>[]) => rows.length
  ? rows.forEach((r) => console.log('  ' + Object.entries(r).map(([k, v]) => `${k}=${n(v)}`).join('  ')))
  : console.log('  (none)')
const h = (s: string) => console.log(`\n${'─'.repeat(76)}\n${s}\n${'─'.repeat(76)}`)

h('1. Hourly rule-execution rate (what the breaker actually counts), last 7 days')
show(await q(`
  WITH hourly AS (
    SELECT date_trunc('hour', e."startedAt") AS hr, COUNT(*)::int AS actions
    FROM "AutomationRuleExecution" e
    JOIN "AutomationRule" r ON r.id = e."ruleId"
    WHERE r.domain = 'advertising'
      AND e.status IN ('SUCCESS','PARTIAL')
      AND e."startedAt" > now() - interval '7 days'
    GROUP BY 1
  )
  SELECT COUNT(*)::int AS hours_with_activity,
         MIN(actions) AS min, MAX(actions) AS max,
         ROUND(AVG(actions))::int AS mean,
         PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY actions)::int AS p50,
         PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY actions)::int AS p95,
         COUNT(*) FILTER (WHERE actions > 250)::int AS hours_over_250
  FROM hourly
`))

h('2. The busiest hours — is 264 an outlier or the norm?')
show(await q(`
  SELECT date_trunc('hour', e."startedAt")::text AS hour, COUNT(*)::int AS actions
  FROM "AutomationRuleExecution" e
  JOIN "AutomationRule" r ON r.id = e."ruleId"
  WHERE r.domain = 'advertising' AND e.status IN ('SUCCESS','PARTIAL')
    AND e."startedAt" > now() - interval '7 days'
  GROUP BY 1 ORDER BY 2 DESC LIMIT 8
`))

h('3. Which rules produce the volume?')
show(await q(`
  SELECT r.name, COUNT(*)::int AS executions_7d
  FROM "AutomationRuleExecution" e
  JOIN "AutomationRule" r ON r.id = e."ruleId"
  WHERE r.domain = 'advertising' AND e.status IN ('SUCCESS','PARTIAL')
    AND e."startedAt" > now() - interval '7 days'
  GROUP BY r.name ORDER BY 2 DESC LIMIT 8
`))

h('4. Confirm the guard does NOT count rank-defend mutations')
show(await q(`
  SELECT 'AdMutation rows last 24h' AS what, COUNT(*)::int AS n
  FROM "AdMutation" WHERE "createdAt" > now() - interval '24 hours'
  UNION ALL
  SELECT 'of those, actor like automation:rank-defend%',
         COUNT(*)::int FROM "AdMutation"
  WHERE "createdAt" > now() - interval '24 hours' AND actor LIKE 'automation:rank-defend%'
`))

h('5. Current halt + thresholds')
show(await q(`
  SELECT autonomy, halted, "haltReason", "haltedBy", "haltedAt"::text AS halted_at,
         "maxActionsPerHour", "maxHourlySpendCentsEur"
  FROM "AdsAutomationState" WHERE id = 'singleton'
`))

await p.$disconnect()
console.log('\nDone — read-only.\n')
