#!/usr/bin/env node
// AD.3 — End-to-end verifier:
//   1. Seed an AutomationRule for trigger=FBA_AGE_THRESHOLD_REACHED
//      (enabled, dryRun, conditions match daysToLtsThreshold <= 14)
//   2. Insert a FbaStorageAge row with daysToLtsThreshold=10
//   3. Run runAdvertisingRuleEvaluatorOnce()
//   4. Assert ≥1 AutomationRuleExecution row created with status=DRY_RUN

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

const TEST_RULE_NAME = `[verifier] AD.3 fba age trigger ${Date.now()}`
const TEST_SKU = `XAV-VERIFIER-AGED-${Date.now()}`

// 1. Insert AutomationRule.
const ruleRows = await c.query(
  `INSERT INTO "AutomationRule" (id, name, description, domain, trigger, conditions, actions,
                                  enabled, "dryRun", "maxExecutionsPerDay", "maxDailyAdSpendCentsEur", "createdBy", "updatedAt")
   VALUES ($1, $2, 'verifier rule', 'advertising', 'FBA_AGE_THRESHOLD_REACHED',
           '[{"field":"fbaAge.daysToLtsThreshold","op":"lte","value":14}]'::jsonb,
           '[{"type":"notify","target":"operator","message":"verifier"}]'::jsonb,
           true, true, 10, 5000, 'verifier-script', NOW())
   RETURNING id`,
  [`verif-${Date.now()}`, TEST_RULE_NAME],
)
const ruleId = ruleRows.rows[0].id
console.log(`Inserted test rule ${ruleId}`)

// 2. Insert FbaStorageAge row with daysToLtsThreshold=10.
await c.query(
  `INSERT INTO "FbaStorageAge" (id, sku, asin, marketplace, "polledAt",
                                "quantityInAge0_90", "quantityInAge91_180",
                                "quantityInAge181_270", "quantityInAge271_365",
                                "quantityInAge365Plus", "currentStorageFeeCents",
                                "projectedLtsFee30dCents", "projectedLtsFee60dCents",
                                "projectedLtsFee90dCents", "daysToLtsThreshold")
   VALUES ($1, $2, 'B0VERIFIER', 'IT', NOW(),
           0, 0, 50, 0, 0, 200,
           5000, 5000, 5000,
           10)`,
  [`fbaage-${Date.now()}`, TEST_SKU],
)
console.log(`Inserted FbaStorageAge sku=${TEST_SKU} daysToLts=10`)

// 3. Run the evaluator.
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
const lines = runResult.stdout.trim().split('\n')
const summary = JSON.parse(lines[lines.length - 1])
console.log(`Evaluator summary: fba=${summary.fbaAgeContexts} evals=${summary.totalEvaluations} matches=${summary.totalMatches}`)

if (summary.fbaAgeContexts < 1) {
  fail(`expected ≥ 1 fbaAgeContexts (test row), got ${summary.fbaAgeContexts}`)
}
if (summary.totalEvaluations < 1) {
  fail(`expected ≥ 1 evaluations, got ${summary.totalEvaluations}`)
}
if (summary.totalMatches < 1) {
  fail(`expected ≥ 1 matches, got ${summary.totalMatches}`)
}

// 4. Check AutomationRuleExecution.
const exec = await c.query(
  `SELECT id, status, "dryRun" FROM "AutomationRuleExecution" WHERE "ruleId" = $1 ORDER BY "startedAt" DESC LIMIT 1`,
  [ruleId],
)
if (exec.rows.length === 1 && exec.rows[0].status === 'DRY_RUN' && exec.rows[0].dryRun === true) {
  pass(`AutomationRuleExecution row created with status=DRY_RUN`)
} else {
  fail(`expected 1 DRY_RUN execution row, got ${JSON.stringify(exec.rows)}`)
}

// Cleanup.
await c.query(`DELETE FROM "AutomationRule" WHERE id = $1`, [ruleId])
await c.query(`DELETE FROM "FbaStorageAge" WHERE sku = $1`, [TEST_SKU])
console.log('Cleaned up test rule + fixture row.')

await c.end()
process.exit(exitCode)
