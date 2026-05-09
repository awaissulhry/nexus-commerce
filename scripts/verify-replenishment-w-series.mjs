#!/usr/bin/env node
/**
 * Session capstone — verify-replenishment-w-series.mjs
 *
 * Smoke-checks the DB-side outputs of every W-series commit landed in
 * this session against the live database. Each check prints PASS or
 * FAIL with the observed state. Exits 0 when every check passes,
 * non-zero when anything's off.
 *
 * What this verifies (DB-side only, doesn't hit the API):
 *
 *   W1 — Operational priming
 *     * DailySalesAggregate populated (W1.1 hooks + W1.2 backfill)
 *
 *   W4 — Automation cornerstone
 *     * AutomationRule + AutomationRuleExecution tables exist
 *     * Default counters initialized correctly
 *     * (Operator must run "Seed templates" to populate rules)
 *
 *   W5 — Scenario modeling
 *     * Scenario + ScenarioRun tables exist
 *
 *   W6 — Slow-mover dashboard
 *     * Notification table accessible (markdown / write-off handoffs)
 *
 *   W4.6 — automation-rule-evaluator cron
 *     * Cron run history (after env-flag enabled)
 *
 * Each check is independent — one failure doesn't abort the run, so
 * the operator gets the full picture in one shot.
 */

import dotenv from 'dotenv'
import { fileURLToPath } from 'url'
import path from 'path'
import pg from 'pg'

const here = path.dirname(fileURLToPath(import.meta.url))
dotenv.config({ path: path.join(here, '..', '.env') })

let url = process.env.DATABASE_URL
if (!url) { console.error('DATABASE_URL missing'); process.exit(1) }
url = url.replace('-pooler', '')

const c = new pg.Client({ connectionString: url })
await c.connect()

const results = []
function pass(label, detail) {
  results.push({ ok: true, label, detail })
  console.log(`✅ ${label}`, detail ?? '')
}
function fail(label, detail) {
  results.push({ ok: false, label, detail })
  console.log(`❌ ${label}`, detail ?? '')
}
function warn(label, detail) {
  results.push({ ok: true, label, detail, warn: true })
  console.log(`⚠️  ${label}`, detail ?? '')
}

async function tableExists(name) {
  const r = await c.query(
    `SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name=$1`,
    [name],
  )
  return r.rowCount > 0
}

async function rowCount(table, where = '') {
  const r = await c.query(`SELECT count(*)::bigint AS n FROM "${table}" ${where}`)
  return Number(r.rows[0].n ?? 0)
}

console.log('━━━ W1 — Operational priming ━━━')
{
  const dsaRows = await rowCount('DailySalesAggregate')
  if (dsaRows > 0) pass('DailySalesAggregate populated', `(${dsaRows} rows)`)
  else fail('DailySalesAggregate empty', '— run scripts/backfill-sales-aggregates.mjs')
}

console.log('\n━━━ W4 — Automation cornerstone ━━━')
{
  if (await tableExists('AutomationRule')) pass('AutomationRule table')
  else fail('AutomationRule table missing', '— W4.1 migration not applied')

  if (await tableExists('AutomationRuleExecution')) pass('AutomationRuleExecution table')
  else fail('AutomationRuleExecution table missing')

  const ruleCount = await rowCount('AutomationRule')
  if (ruleCount === 0) {
    warn('No automation rules seeded', '— click "Seed templates" on the workspace')
  } else {
    const r = await c.query(`SELECT count(*)::int AS n, count(*) FILTER (WHERE enabled = true)::int AS active, count(*) FILTER (WHERE "dryRun" = true)::int AS dry FROM "AutomationRule"`)
    pass('Automation rules seeded', `(${r.rows[0].n} total · ${r.rows[0].active} active · ${r.rows[0].dry} dry-run)`)
  }

  // Counter sanity: every rule should have non-negative counters
  const badCounters = await c.query(`SELECT count(*)::int AS n FROM "AutomationRule" WHERE "evaluationCount" < 0 OR "matchCount" < 0 OR "executionCount" < 0`)
  if (badCounters.rows[0].n === 0) pass('Automation counters non-negative')
  else fail('Negative automation counters detected', `${badCounters.rows[0].n} rule(s)`)
}

console.log('\n━━━ W5 — Scenario modeling ━━━')
{
  if (await tableExists('Scenario')) pass('Scenario table')
  else fail('Scenario table missing', '— W5.1 migration not applied')

  if (await tableExists('ScenarioRun')) pass('ScenarioRun table')
  else fail('ScenarioRun table missing')

  const scenarioCount = await rowCount('Scenario')
  if (scenarioCount === 0) warn('No scenarios created yet', '— optional')
  else pass('Scenarios present', `(${scenarioCount})`)

  // Validate kind enum: only the 3 supported kinds
  const badKinds = await c.query(`SELECT DISTINCT kind FROM "Scenario" WHERE kind NOT IN ('PROMOTIONAL_UPLIFT', 'LEAD_TIME_DISRUPTION', 'SUPPLIER_SWAP')`)
  if (badKinds.rowCount === 0) pass('Scenario kinds within enum')
  else fail('Unknown scenario kinds', badKinds.rows.map(r => r.kind).join(', '))
}

console.log('\n━━━ W6 — Slow-mover handoffs ━━━')
{
  if (await tableExists('Notification')) pass('Notification table')
  else fail('Notification table missing')

  const handoffNotifications = await c.query(`
    SELECT type, count(*)::int AS n
    FROM "Notification"
    WHERE type IN ('markdown-suggestion', 'write-off-candidate')
    GROUP BY type
  `)
  if (handoffNotifications.rowCount === 0) {
    warn('No slow-mover handoffs fired yet', '— click Tag/Trash on a slow-mover row')
  } else {
    for (const row of handoffNotifications.rows) {
      pass(`Notifications: ${row.type}`, `(${row.n})`)
    }
  }
}

console.log('\n━━━ W4.6 — automation-rule-evaluator cron ━━━')
{
  const r = await c.query(`
    SELECT count(*)::int AS n, MAX("startedAt") AS most_recent
    FROM "CronRun"
    WHERE "jobName" = 'automation-rule-evaluator'
      AND "startedAt" > NOW() - INTERVAL '7 days'
  `)
  const n = r.rows[0].n
  if (n === 0) {
    warn('automation-rule-evaluator hasn\'t run in 7d', '— set NEXUS_ENABLE_AUTOMATION_RULE_CRON=1')
  } else {
    pass('automation-rule-evaluator cron alive', `(${n} runs · most recent ${r.rows[0].most_recent})`)
  }
}

console.log('\n━━━ Summary ━━━')
const failures = results.filter((r) => !r.ok).length
const warnings = results.filter((r) => r.warn).length
const passes = results.filter((r) => r.ok && !r.warn).length
console.log(`${passes} passed · ${warnings} warnings · ${failures} failed`)

await c.end()
process.exit(failures > 0 ? 1 : 0)
