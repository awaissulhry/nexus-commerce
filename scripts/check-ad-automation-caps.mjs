#!/usr/bin/env node
// AD.3 — Verifies the per-day execution cap (maxExecutionsPerDay).
//   1. Seed rule with maxExecutionsPerDay=2 + always-match condition
//   2. Insert 3 FbaStorageAge rows (3 distinct contexts)
//   3. Run evaluator
//   4. Assert: 2 executions with status=DRY_RUN, 1 with status=CAP_EXCEEDED

import dotenv from 'dotenv'
import path from 'path'
import { fileURLToPath } from 'url'
import pg from 'pg'

const here = path.dirname(fileURLToPath(import.meta.url))
dotenv.config({ path: path.join(here, '..', '.env') })

process.env.NEXUS_AMAZON_ADS_MODE = 'sandbox'

const url = process.env.DATABASE_URL?.replace('-pooler', '')
if (!url) {
  console.error('DATABASE_URL missing — set it in .env')
  process.exit(1)
}

let exitCode = 0
function fail(msg) {
  console.error(`  ✗ ${msg}`)
  exitCode = 1
}
function pass(msg) {
  console.log(`  ✓ ${msg}`)
}

const c = new pg.Client({ connectionString: url })
await c.connect()

const TEST_RULE_NAME = `[verifier] AD.3 daily cap ${Date.now()}`
const SKU_BASE = `XAV-CAP-${Date.now()}`

const ruleRows = await c.query(
  `INSERT INTO "AutomationRule" (id, name, description, domain, trigger, conditions, actions,
                                  enabled, "dryRun", "maxExecutionsPerDay", "createdBy", "updatedAt")
   VALUES ($1, $2, 'verifier cap rule', 'advertising', 'FBA_AGE_THRESHOLD_REACHED',
           '[]'::jsonb,
           '[{"type":"notify","target":"operator","message":"capped"}]'::jsonb,
           true, true, 2, 'verifier-script', NOW())
   RETURNING id`,
  [`verif-cap-${Date.now()}`, TEST_RULE_NAME],
)
const ruleId = ruleRows.rows[0].id

for (let i = 0; i < 3; i++) {
  await c.query(
    `INSERT INTO "FbaStorageAge" (id, sku, asin, marketplace, "polledAt",
                                   "quantityInAge0_90", "quantityInAge91_180",
                                   "quantityInAge181_270", "quantityInAge271_365",
                                   "quantityInAge365Plus", "currentStorageFeeCents",
                                   "projectedLtsFee30dCents", "projectedLtsFee60dCents",
                                   "projectedLtsFee90dCents", "daysToLtsThreshold")
     VALUES ($1, $2, NULL, 'IT', NOW(),
             0, 0, 10, 0, 0, 100, 1000, 1000, 1000, 10)`,
    [`fbaage-cap-${Date.now()}-${i}`, `${SKU_BASE}-${i}`],
  )
}

const { spawnSync } = await import('node:child_process')
const apiRoot = path.join(here, '..', 'apps', 'api')
const runResult = spawnSync(
  'node',
  [
    '--import',
    'tsx',
    '-e',
    `
    import { runAdvertisingRuleEvaluatorOnce } from './src/jobs/advertising-rule-evaluator.job.ts'
    const summary = await runAdvertisingRuleEvaluatorOnce()
    console.log(JSON.stringify(summary))
    `,
  ],
  { cwd: apiRoot, encoding: 'utf8' },
)
if (runResult.status !== 0) {
  fail(`evaluator execution failed: ${runResult.stderr}`)
  process.exit(1)
}
const summary = JSON.parse(runResult.stdout.trim().split('\n').pop())
console.log(`Evaluator summary: fba=${summary.fbaAgeContexts} evals=${summary.totalEvaluations} matches=${summary.totalMatches}`)

// Filter executions to this rule, today, just inserted.
const exec = await c.query(
  `SELECT status, COUNT(*) AS n FROM "AutomationRuleExecution" WHERE "ruleId" = $1 GROUP BY status`,
  [ruleId],
)
const counts = {}
for (const row of exec.rows) counts[row.status] = Number(row.n)

if (counts.DRY_RUN === 2 && counts.CAP_EXCEEDED === 1) {
  pass(`2 DRY_RUN + 1 CAP_EXCEEDED as expected (maxExecutionsPerDay=2)`)
} else {
  fail(`expected DRY_RUN=2 + CAP_EXCEEDED=1, got ${JSON.stringify(counts)}`)
}

// Cleanup.
await c.query(`DELETE FROM "AutomationRule" WHERE id = $1`, [ruleId])
await c.query(`DELETE FROM "FbaStorageAge" WHERE sku LIKE $1`, [`${SKU_BASE}-%`])

await c.end()
process.exit(exitCode)
