#!/usr/bin/env node
// AD.5 — Verifies URGENCY_WEIGHTED rebalancer: aged stock only in DE,
// expect DE share to be the biggest.

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

async function makeCampaign(marketplace, name) {
  const id = `verifUW-camp-${marketplace}-${ts}`
  await c.query(
    `INSERT INTO "Campaign" (id, name, type, status, "dailyBudget", "startDate", marketplace, "externalCampaignId", "biddingStrategy", "dailyBudgetCurrency", "updatedAt")
     VALUES ($1, $2, 'SP', 'ENABLED', 30, NOW(), $3, $4, 'LEGACY_FOR_SALES', 'EUR', NOW())`,
    [id, name, marketplace, `EXT-${id}`],
  )
  cleanup.push(['Campaign', id])
  return id
}

const itCamp = await makeCampaign('IT', '[verifUW] IT no aged')
const deCamp = await makeCampaign('DE', '[verifUW] DE aged stock')

// Seed aged stock in DE only.
const fbaId = `verifUW-fba-${ts}`
await c.query(
  `INSERT INTO "FbaStorageAge" (id, sku, asin, marketplace, "polledAt",
                                "quantityInAge0_90", "quantityInAge91_180",
                                "quantityInAge181_270", "quantityInAge271_365",
                                "quantityInAge365Plus", "currentStorageFeeCents",
                                "projectedLtsFee30dCents", "projectedLtsFee60dCents",
                                "projectedLtsFee90dCents", "daysToLtsThreshold")
   VALUES ($1, $2, NULL, 'DE', NOW(),
           0, 0, 100, 50, 0, 500,
           50000, 100000, 150000, 10)`,
  [fbaId, `VERIFUW-AGED-${ts}`],
)
cleanup.push(['FbaStorageAge', fbaId])

const poolId = `verifUW-pool-${ts}`
await c.query(
  `INSERT INTO "BudgetPool" (id, name, "totalDailyBudgetCents", strategy, "coolDownMinutes", "maxShiftPerRebalancePct", enabled, "dryRun", "createdBy", "updatedAt")
   VALUES ($1, $2, 6000, 'URGENCY_WEIGHTED', 0, 80, true, true, 'verifier', NOW())`,
  [poolId, `[verifUW] pool ${ts}`],
)
cleanup.push(['BudgetPool', poolId])

for (const [marketplace, campaignId] of [
  ['IT', itCamp],
  ['DE', deCamp],
]) {
  const allocId = `verifUW-alloc-${marketplace}-${ts}`
  await c.query(
    `INSERT INTO "BudgetPoolAllocation" (id, "budgetPoolId", marketplace, "campaignId", "targetSharePct", "minDailyBudgetCents", "updatedAt")
     VALUES ($1, $2, $3, $4, 0, 100, NOW())`,
    [allocId, poolId, marketplace, campaignId],
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
    import { computeRebalance } from './src/services/advertising/budget-pool-rebalancer.service.ts'
    const r = await computeRebalance({ poolId: '${poolId}', triggeredBy: 'user:verifier', ignoreCoolDown: true })
    console.log(JSON.stringify(r))
    `,
  ],
  { cwd: apiRoot, encoding: 'utf8' },
)
if (runResult.status !== 0) {
  fail(`compute failed: ${runResult.stderr}`)
  await teardown()
  process.exit(1)
}
const outcome = JSON.parse(runResult.stdout.trim().split('\n').pop())
console.log(`Outcome: totalShift=${outcome.totalShiftCents}¢`)

const byMkt = Object.fromEntries(
  outcome.proposed.map((p) => [p.marketplace, p.proposedBudgetCents]),
)
if (byMkt.DE > byMkt.IT) {
  pass(`DE share > IT share (aged stock in DE only): DE=${byMkt.DE}¢ vs IT=${byMkt.IT}¢`)
} else {
  fail(`DE should outrank IT given urgency, got DE=${byMkt.DE}¢ IT=${byMkt.IT}¢`)
}

await teardown()
await c.end()
process.exit(exitCode)

async function teardown() {
  for (const [table, id] of cleanup.reverse()) {
    await c.query(`DELETE FROM "${table}" WHERE id = $1`, [id]).catch(() => {})
  }
}
