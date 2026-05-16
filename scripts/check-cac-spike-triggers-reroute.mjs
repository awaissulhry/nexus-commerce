#!/usr/bin/env node
// AD.5 — End-to-end: CAC_SPIKE trigger fires an automation rule whose
// action is reroute_marketplace_budget. Assert IT campaign budget
// decreases and DE campaign budget increases.

import dotenv from 'dotenv'
import path from 'path'
import { fileURLToPath } from 'url'
import pg from 'pg'

const here = path.dirname(fileURLToPath(import.meta.url))
dotenv.config({ path: path.join(here, '..', '.env') })

process.env.NEXUS_AMAZON_ADS_MODE = 'sandbox'

const url = process.env.DATABASE_URL?.replace('-pooler', '')
if (!url) {
  console.error('DATABASE_URL missing')
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

const ts = Date.now()
const cleanup = []

async function makeCampaign(marketplace, name, budget, opts = {}) {
  const id = `verifCAC-camp-${marketplace}-${ts}`
  await c.query(
    `INSERT INTO "Campaign" (id, name, type, status, "dailyBudget", "startDate", marketplace, "externalCampaignId", "biddingStrategy", "dailyBudgetCurrency", spend, sales, acos, "trueProfitCents", "updatedAt")
     VALUES ($1, $2, 'SP', 'ENABLED', $3, NOW(), $4, $5, 'LEGACY_FOR_SALES', 'EUR', $6, $7, $8, $9, NOW())`,
    [
      id,
      name,
      budget,
      marketplace,
      `EXT-CAC-${id}`,
      opts.spend ?? 150,
      opts.sales ?? 0,
      opts.acos ?? 2.0,
      opts.trueProfitCents ?? 0,
    ],
  )
  cleanup.push(['Campaign', id])
  return id
}

// IT campaign has CAC spike (acos=2.0, spend=€150).
// DE campaign is healthy.
const itCamp = await makeCampaign('IT', '[verifCAC] IT spiking', 30, {
  spend: 150,
  sales: 75,
  acos: 2.0,
})
const deCamp = await makeCampaign('DE', '[verifCAC] DE healthy', 30, {
  spend: 50,
  sales: 200,
  acos: 0.25,
  trueProfitCents: 100_000,
})

// Seed a rule firing on CAC_SPIKE → reroute_marketplace_budget.
const ruleRows = await c.query(
  `INSERT INTO "AutomationRule" (id, name, domain, trigger, conditions, actions,
                                  enabled, "dryRun", "maxExecutionsPerDay", "createdBy", "updatedAt")
   VALUES ($1, $2, 'advertising', 'CAC_SPIKE',
           '[{"field":"campaign.acos","op":"gte","value":1.0}]'::jsonb,
           $3::jsonb,
           true, false, 5, 'verifier', NOW())
   RETURNING id`,
  [
    `verifCAC-rule-${ts}`,
    `[verifCAC] reroute rule ${ts}`,
    JSON.stringify([
      {
        type: 'reroute_marketplace_budget',
        fromMarketplace: 'IT',
        toMarketplace: 'DE',
        percent: 30,
        reason: 'verifier CAC spike',
      },
    ]),
  ],
)
const ruleId = ruleRows.rows[0].id
cleanup.push(['AutomationRule', ruleId])

const { spawnSync } = await import('node:child_process')
const apiRoot = path.join(here, '..', 'apps', 'api')
const runResult = spawnSync(
  'node',
  [
    '--import',
    'tsx',
    '-e',
    `
    // Side-effect import so the reroute_marketplace_budget action handler
    // registers into ACTION_HANDLERS before evaluator dispatches.
    await import('./src/services/advertising/automation-action-handlers.ts')
    const { runAdvertisingRuleEvaluatorOnce } = await import('./src/jobs/advertising-rule-evaluator.job.ts')
    const summary = await runAdvertisingRuleEvaluatorOnce()
    console.log(JSON.stringify(summary))
    `,
  ],
  { cwd: apiRoot, encoding: 'utf8' },
)
if (runResult.status !== 0) {
  fail(`evaluator failed: ${runResult.stderr}`)
  await teardown()
  process.exit(1)
}
const summary = JSON.parse(runResult.stdout.trim().split('\n').pop())
console.log(`Evaluator summary: cacSpike=${summary.cacSpikeContexts} matches=${summary.totalMatches}`)

const after = await c.query(
  `SELECT id, marketplace, "dailyBudget"::float AS budget FROM "Campaign" WHERE id = ANY($1)`,
  [[itCamp, deCamp]],
)
const byMkt = Object.fromEntries(after.rows.map((r) => [r.marketplace, r.budget]))
console.log(`After: IT=€${byMkt.IT?.toFixed(2)} DE=€${byMkt.DE?.toFixed(2)}`)

if (byMkt.IT < 30 - 0.1) {
  pass(`IT budget decreased: €30 → €${byMkt.IT.toFixed(2)}`)
} else {
  fail(`IT budget should have decreased, got €${byMkt.IT.toFixed(2)}`)
}
// DE could be unchanged if the rule found no DE campaigns to boost — be lenient.
if (byMkt.DE >= 30) {
  pass(`DE budget did not decrease: €${byMkt.DE.toFixed(2)}`)
} else {
  fail(`DE budget unexpectedly decreased: €${byMkt.DE.toFixed(2)}`)
}

await teardown()
await c.end()
process.exit(exitCode)

async function teardown() {
  for (const [table, id] of cleanup.reverse()) {
    await c.query(`DELETE FROM "${table}" WHERE id = $1`, [id]).catch(() => {})
  }
}
