/**
 * ADX.0 — Control audit. READ-ONLY.
 *
 * Answers four questions with prod data:
 *   A. What is actually running?        (CronRun)
 *   B. Who is actually writing?         (AdMutation.actor)
 *   C. Do writers contend for fields?   (the conflict rate — tests the §1.10 diagnosis)
 *   D. Is the audit trail complete?     (AdvertisingActionLog vs AdMutation)
 *
 * Usage: cd apps/api && npx tsx scripts/_adx0-control-audit.mts [windowDays=90]
 */
import { resolve } from 'path'
import { config } from 'dotenv'
config()
config({ path: resolve(new URL('.', import.meta.url).pathname, '../../../.env') })

const { PrismaClient } = await import('@prisma/client')
const p = new PrismaClient()

const WINDOW_DAYS = Number(process.argv[2] ?? 90)
const q = <T = Record<string, unknown>>(sql: string) => p.$queryRawUnsafe<T[]>(sql)
const j = (v: unknown) => (typeof v === 'bigint' ? Number(v) : v)
const table = (rows: Record<string, unknown>[]) => {
  if (!rows.length) return '  (none)'
  return rows.map((r) => '  ' + Object.entries(r).map(([k, v]) => `${k}=${j(v)}`).join('  ')).join('\n')
}

const hr = (t: string) => console.log(`\n${'='.repeat(78)}\n${t}\n${'='.repeat(78)}`)

// ── A. What is actually running ──────────────────────────────────────────────
hr('A. CRON REALITY — what actually ran (last 14 days)')
const crons = await q(`
  SELECT "jobName",
         COUNT(*)                                            AS runs,
         COUNT(*) FILTER (WHERE status = 'SUCCESS')          AS ok,
         COUNT(*) FILTER (WHERE status = 'FAILED')           AS failed,
         COUNT(*) FILTER (WHERE status = 'RUNNING')          AS stuck,
         MAX("startedAt")::text                              AS last_run
  FROM "CronRun"
  WHERE "startedAt" > now() - interval '14 days'
  GROUP BY "jobName"
  ORDER BY MAX("startedAt") DESC
`)
console.log(table(crons))
console.log(`\n  distinct jobs seen: ${crons.length}`)

// Ads jobs specifically — absence here is the finding.
const ADS_JOBS = ['ads-sync', 'ads-metrics-ingest', 'ad-rank-defend', 'ad-dayparting', 'ads-tos-defense',
  'tos-is-ingest', 'sqp-ingest', 'ads-structural-reconcile', 'advertising-rule-evaluator',
  'budget-pool-rebalance', 'ad-budget-enforce', 'ad-autopilot', 'ads-sync-drain']
const seen = new Set(crons.map((c) => String(c.jobName)))
console.log(`\n  ads jobs NOT seen in 14d: ${ADS_JOBS.filter((n) => !seen.has(n)).join(', ') || '(all present)'}`)

// ── B. Who is actually writing ───────────────────────────────────────────────
hr(`B. WRITE REALITY — AdMutation by actor (last ${WINDOW_DAYS} days)`)
const total = await q(`SELECT COUNT(*) AS n FROM "AdMutation" WHERE "createdAt" > now() - interval '${WINDOW_DAYS} days'`)
const totalN = Number(total[0]?.n ?? 0)
console.log(`  total mutations in window: ${totalN}`)
if (totalN > 0) {
  console.log(table(await q(`
    SELECT actor,
           COUNT(*)                                          AS mutations,
           COUNT(DISTINCT "entityId")                        AS entities,
           COUNT(*) FILTER (WHERE state = 'APPLIED')         AS applied,
           COUNT(*) FILTER (WHERE state = 'FAILED')          AS failed,
           COUNT(*) FILTER (WHERE state = 'SUPERSEDED')      AS superseded,
           MAX("createdAt")::text                            AS last_write
    FROM "AdMutation"
    WHERE "createdAt" > now() - interval '${WINDOW_DAYS} days'
    GROUP BY actor ORDER BY COUNT(*) DESC
  `)))
  console.log('\n  by field:')
  console.log(table(await q(`
    SELECT field, COUNT(*) AS mutations, COUNT(DISTINCT actor) AS distinct_actors
    FROM "AdMutation"
    WHERE "createdAt" > now() - interval '${WINDOW_DAYS} days'
    GROUP BY field ORDER BY COUNT(*) DESC LIMIT 20
  `)))
}

// ── C. The conflict rate — the test of the diagnosis ─────────────────────────
hr(`C. CONFLICT RATE — do different engines contend for the same field?`)
if (totalN === 0) {
  console.log('  NO MUTATION HISTORY IN WINDOW — the conflict hypothesis cannot be tested from history.')
  console.log('  The §1.10 diagnosis would then rest on code structure alone (7 writers, no arbitration),')
  console.log('  which is still true but unquantified. Widen the window or accept the structural argument.')
} else {
  const contested = await q(`
    SELECT COUNT(*) AS contested_fields FROM (
      SELECT "entityType","entityId",field
      FROM "AdMutation"
      WHERE "createdAt" > now() - interval '${WINDOW_DAYS} days'
      GROUP BY 1,2,3 HAVING COUNT(DISTINCT actor) > 1
    ) t
  `)
  const allFields = await q(`
    SELECT COUNT(*) AS all_fields FROM (
      SELECT "entityType","entityId",field FROM "AdMutation"
      WHERE "createdAt" > now() - interval '${WINDOW_DAYS} days' GROUP BY 1,2,3
    ) t
  `)
  const cf = Number(contested[0]?.contested_fields ?? 0)
  const af = Number(allFields[0]?.all_fields ?? 0)
  console.log(`  fields touched by >1 distinct actor: ${cf} / ${af}` + (af ? `  (${((cf / af) * 100).toFixed(1)}%)` : ''))

  // Consecutive writes on one field by DIFFERENT actors, close in time = a real contention event.
  for (const hours of [1, 6, 24]) {
    const ev = await q(`
      WITH m AS (
        SELECT "entityType","entityId",field,actor,"intendedValue","createdAt",
               LAG(actor)          OVER w AS prev_actor,
               LAG("createdAt")    OVER w AS prev_at,
               LAG("intendedValue")OVER w AS prev_val
        FROM "AdMutation"
        WHERE "createdAt" > now() - interval '${WINDOW_DAYS} days'
        WINDOW w AS (PARTITION BY "entityType","entityId",field ORDER BY "createdAt")
      )
      SELECT COUNT(*) AS events,
             COUNT(*) FILTER (WHERE "intendedValue" IS DISTINCT FROM prev_val) AS value_changed
      FROM m
      WHERE prev_actor IS NOT NULL AND prev_actor <> actor
        AND "createdAt" - prev_at < interval '${hours} hours'
    `)
    console.log(`  contention events within ${String(hours).padStart(2)}h: events=${j(ev[0]?.events)}  value_actually_changed=${j(ev[0]?.value_changed)}`)
  }

  console.log('\n  worst actor pairs (consecutive different-actor writes within 24h):')
  console.log(table(await q(`
    WITH m AS (
      SELECT "entityType","entityId",field,actor,"createdAt",
             LAG(actor)       OVER w AS prev_actor,
             LAG("createdAt") OVER w AS prev_at
      FROM "AdMutation"
      WHERE "createdAt" > now() - interval '${WINDOW_DAYS} days'
      WINDOW w AS (PARTITION BY "entityType","entityId",field ORDER BY "createdAt")
    )
    SELECT prev_actor || ' -> ' || actor AS handoff, field, COUNT(*) AS events
    FROM m
    WHERE prev_actor IS NOT NULL AND prev_actor <> actor AND "createdAt" - prev_at < interval '24 hours'
    GROUP BY 1,2 ORDER BY COUNT(*) DESC LIMIT 15
  `)))

  console.log('\n  oscillation — fields whose value returned to an earlier value within 24h:')
  console.log(table(await q(`
    WITH m AS (
      SELECT "entityType","entityId",field,"intendedValue","createdAt",
             LAG("intendedValue",1) OVER w AS v1,
             LAG("intendedValue",2) OVER w AS v2,
             LAG("createdAt",2)     OVER w AS at2
      FROM "AdMutation"
      WHERE "createdAt" > now() - interval '${WINDOW_DAYS} days'
      WINDOW w AS (PARTITION BY "entityType","entityId",field ORDER BY "createdAt")
    )
    SELECT field, COUNT(*) AS flip_flops, COUNT(DISTINCT "entityId") AS entities
    FROM m
    WHERE v2 IS NOT NULL AND "intendedValue" = v2 AND "intendedValue" IS DISTINCT FROM v1
      AND "createdAt" - at2 < interval '24 hours'
    GROUP BY field ORDER BY COUNT(*) DESC LIMIT 10
  `)))
}

// ── D. Attribution completeness ──────────────────────────────────────────────
hr(`D. ATTRIBUTION GAP — AdvertisingActionLog coverage (last ${WINDOW_DAYS} days)`)
const logN = await q(`SELECT COUNT(*) AS n FROM "AdvertisingActionLog" WHERE "createdAt" > now() - interval '${WINDOW_DAYS} days'`)
console.log(`  AdMutation rows:           ${totalN}`)
console.log(`  AdvertisingActionLog rows: ${Number(logN[0]?.n ?? 0)}`)
console.log('\n  action log by type:')
console.log(table(await q(`
  SELECT "actionType", COUNT(*) AS n,
         COUNT(*) FILTER (WHERE "executionId" IS NOT NULL) AS from_rule,
         COUNT(*) FILTER (WHERE "userId" IS NOT NULL)      AS from_human
  FROM "AdvertisingActionLog"
  WHERE "createdAt" > now() - interval '${WINDOW_DAYS} days'
  GROUP BY 1 ORDER BY COUNT(*) DESC LIMIT 20
`)))
console.log('\n  rows attributable to NEITHER a rule NOR a human (i.e. a cron, unexplained):')
console.log(table(await q(`
  SELECT COUNT(*) AS orphan_rows
  FROM "AdvertisingActionLog"
  WHERE "createdAt" > now() - interval '${WINDOW_DAYS} days'
    AND "executionId" IS NULL AND "userId" IS NULL
`)))

// ── Supporting context ───────────────────────────────────────────────────────
hr('E. CONTEXT — scale of the account')
for (const [label, sql] of [
  ['campaigns',        'SELECT COUNT(*) AS n FROM "Campaign"'],
  ['ad targets',       'SELECT COUNT(*) AS n FROM "AdTarget"'],
  ['ad schedules',     'SELECT COUNT(*) AS n, COUNT(*) FILTER (WHERE enabled) AS enabled FROM "AdSchedule"'],
  ['automation rules', 'SELECT COUNT(*) AS n, COUNT(*) FILTER (WHERE enabled) AS enabled, COUNT(*) FILTER (WHERE "dryRun") AS dry_run FROM "AutomationRule" WHERE domain = \'advertising\''],
  ['rule executions',  `SELECT COUNT(*) AS n FROM "AutomationRuleExecution" WHERE "startedAt" > now() - interval '${WINDOW_DAYS} days'`],
  ['rule suggestions', 'SELECT COUNT(*) AS n, COUNT(*) FILTER (WHERE status = \'pending\') AS pending FROM "AdsRuleSuggestion"'],
] as const) {
  try { console.log(`  ${label.padEnd(18)} ${JSON.stringify((await q(sql))[0], (_k, v) => (typeof v === 'bigint' ? Number(v) : v))}`) }
  catch (e) { console.log(`  ${label.padEnd(18)} ERROR ${e instanceof Error ? e.message.split('\n')[0] : e}`) }
}

await p.$disconnect()
console.log('\ndone.\n')
