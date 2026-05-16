#!/usr/bin/env node
// AD.5 — Verifies PROFIT_WEIGHTED rebalancer: 3 marketplaces × synthetic
// profit numbers. Highest-profit marketplace should get the biggest
// proposed share, capped by maxShiftPerRebalancePct.

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

// Pick 3 distinct existing products (need them to wire AdProductAd).
const products = await c.query(
  `SELECT id, "productType" FROM "Product" WHERE "productType" IS NOT NULL LIMIT 3`,
)
if (products.rows.length < 3) {
  console.log('Need at least 3 products with productType — skipping.')
  process.exit(0)
}

const ts = Date.now()
const cleanup = []

async function makeCampaign(marketplace, name, budget) {
  const id = `verifPW-camp-${marketplace}-${ts}`
  await c.query(
    `INSERT INTO "Campaign" (id, name, type, status, "dailyBudget", "startDate", marketplace, "externalCampaignId", "biddingStrategy", "dailyBudgetCurrency", "trueProfitCents", "updatedAt")
     VALUES ($1, $2, 'SP', 'ENABLED', $3, NOW(), $4, $5, 'LEGACY_FOR_SALES', 'EUR', 0, NOW())`,
    [id, name, budget, marketplace, `EXT-${id}`],
  )
  cleanup.push(['Campaign', id])
  return id
}

async function makeAdGroup(campaignId) {
  const id = `verifPW-ag-${campaignId}-${ts}`
  await c.query(
    `INSERT INTO "AdGroup" (id, "campaignId", name, "defaultBidCents", status, "targetingType", "updatedAt")
     VALUES ($1, $2, 'verifier ag', 50, 'ENABLED', 'MANUAL', NOW())`,
    [id, campaignId],
  )
  cleanup.push(['AdGroup', id])
  return id
}

async function makeProductAd(adGroupId, productId) {
  const id = `verifPW-pa-${adGroupId}-${productId}-${ts}`
  await c.query(
    `INSERT INTO "AdProductAd" (id, "adGroupId", "productId", status, "updatedAt")
     VALUES ($1, $2, $3, 'ENABLED', NOW())`,
    [id, adGroupId, productId],
  )
  cleanup.push(['AdProductAd', id])
}

async function seedProfit(productId, marketplace, trueProfitCents) {
  const id = `verifPW-ppd-${productId}-${marketplace}-${ts}`
  await c.query(
    `INSERT INTO "ProductProfitDaily" (id, "productId", marketplace, date, "unitsSold", "grossRevenueCents", "cogsCents", "trueProfitCents", "computedAt", "updatedAt")
     VALUES ($1, $2, $3, NOW()::date, 10, $4 * 2, $4, $4, NOW(), NOW())
     ON CONFLICT ("productId", marketplace, date) DO UPDATE
       SET "trueProfitCents" = EXCLUDED."trueProfitCents",
           "grossRevenueCents" = EXCLUDED."grossRevenueCents"`,
    [id, productId, marketplace, trueProfitCents],
  )
  cleanup.push(['ProductProfitDaily-cleanup', `${productId}::${marketplace}`])
}

// Seed: 3 marketplaces, 3 products with very different profit numbers
// (IT high, DE medium, FR low). Each marketplace gets one campaign.
const itCamp = await makeCampaign('IT', '[verifPW] IT high-profit', 30)
const deCamp = await makeCampaign('DE', '[verifPW] DE medium-profit', 30)
const frCamp = await makeCampaign('FR', '[verifPW] FR low-profit', 30)
const itAg = await makeAdGroup(itCamp)
const deAg = await makeAdGroup(deCamp)
const frAg = await makeAdGroup(frCamp)
await makeProductAd(itAg, products.rows[0].id)
await makeProductAd(deAg, products.rows[1].id)
await makeProductAd(frAg, products.rows[2].id)
await seedProfit(products.rows[0].id, 'IT', 1_000_000) // €10k
await seedProfit(products.rows[1].id, 'DE', 400_000) // €4k
await seedProfit(products.rows[2].id, 'FR', 100_000) // €1k

// Seed pool + allocations.
const poolId = `verifPW-pool-${ts}`
await c.query(
  `INSERT INTO "BudgetPool" (id, name, "totalDailyBudgetCents", strategy, "coolDownMinutes", "maxShiftPerRebalancePct", enabled, "dryRun", "createdBy", "updatedAt")
   VALUES ($1, $2, 12000, 'PROFIT_WEIGHTED', 0, 50, true, true, 'verifier', NOW())`,
  [poolId, `[verifPW] pool ${ts}`],
)
cleanup.push(['BudgetPool', poolId])

for (const [marketplace, campaignId] of [
  ['IT', itCamp],
  ['DE', deCamp],
  ['FR', frCamp],
]) {
  const allocId = `verifPW-alloc-${marketplace}-${ts}`
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
console.log(
  `Outcome: ok=${outcome.ok} totalShift=${outcome.totalShiftCents}¢ proposed=${outcome.proposed?.length}`,
)

if (!outcome.ok) {
  fail(`expected ok=true, got ${JSON.stringify(outcome)}`)
} else {
  const byMkt = Object.fromEntries(
    outcome.proposed.map((p) => [p.marketplace, p.proposedBudgetCents]),
  )
  // IT should have highest, DE middle, FR lowest.
  if (byMkt.IT > byMkt.DE && byMkt.DE > byMkt.FR) {
    pass(`profit ordering preserved: IT > DE > FR (${byMkt.IT}¢ > ${byMkt.DE}¢ > ${byMkt.FR}¢)`)
  } else {
    fail(`profit ordering violated: ${JSON.stringify(byMkt)}`)
  }
  // Shift cap engaged check.
  const maxAllowedShift = (12000 * 50) / 100 // 50% of 12000¢ = 6000¢
  if (outcome.totalShiftCents <= maxAllowedShift + 1) {
    pass(`totalShift respects maxShiftPerRebalancePct (${outcome.totalShiftCents}¢ ≤ ${maxAllowedShift}¢)`)
  } else {
    fail(`shift cap violated: ${outcome.totalShiftCents}¢ > ${maxAllowedShift}¢`)
  }
}

await teardown()
await c.end()
process.exit(exitCode)

async function teardown() {
  // Reverse order, with ProductProfitDaily-cleanup handled specially.
  for (const [table, id] of cleanup.reverse()) {
    if (table === 'ProductProfitDaily-cleanup') {
      const [pid, mkt] = id.split('::')
      await c.query(
        `DELETE FROM "ProductProfitDaily" WHERE "productId" = $1 AND marketplace = $2`,
        [pid, mkt],
      )
    } else {
      await c.query(`DELETE FROM "${table}" WHERE id = $1`, [id]).catch(() => {})
    }
  }
}
