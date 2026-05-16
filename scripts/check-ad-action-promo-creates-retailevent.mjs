#!/usr/bin/env node
// AD.3 — Verifies the create_amazon_promotion action handler.
//   1. Pick a real Product with productType set (need it for RetailEvent scope)
//   2. Seed rule (enabled, dryRun=false) with create_amazon_promotion action
//   3. Insert FbaStorageAge for that product's SKU
//   4. Run evaluator
//   5. Assert: a new RetailEvent row exists, scoped to productType+marketplace,
//      with a linked RetailEventPriceAction of action='PERCENT_OFF', value=15

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

const products = await c.query(
  `SELECT id, sku, "productType" FROM "Product" WHERE "productType" IS NOT NULL LIMIT 1`,
)
if (products.rows.length === 0) {
  console.log('No products with productType — skipping. (Seed at least one Product row first.)')
  process.exit(0)
}
const product = products.rows[0]
console.log(`Test product: ${product.sku} (productType=${product.productType})`)

const TEST_RULE_NAME = `[verifier] AD.3 promo action ${Date.now()}`

const ruleRows = await c.query(
  `INSERT INTO "AutomationRule" (id, name, description, domain, trigger, conditions, actions,
                                  enabled, "dryRun", "maxExecutionsPerDay", "createdBy", "updatedAt")
   VALUES ($1, $2, 'verifier promo rule', 'advertising', 'FBA_AGE_THRESHOLD_REACHED',
           '[]'::jsonb,
           $3::jsonb,
           true, false, 5, 'verifier-script', NOW())
   RETURNING id`,
  [
    `verif-promo-${Date.now()}`,
    TEST_RULE_NAME,
    JSON.stringify([
      {
        type: 'create_amazon_promotion',
        discountPct: 15,
        durationDays: 14,
        reason: 'verifier — create promo',
      },
    ]),
  ],
)
const ruleId = ruleRows.rows[0].id

// Insert FbaStorageAge tied to the product's sku — productId is set so
// the trigger context builder finds product.productType.
const fbaIns = await c.query(
  `INSERT INTO "FbaStorageAge" (id, "productId", sku, asin, marketplace, "polledAt",
                                 "quantityInAge0_90", "quantityInAge91_180",
                                 "quantityInAge181_270", "quantityInAge271_365",
                                 "quantityInAge365Plus", "currentStorageFeeCents",
                                 "projectedLtsFee30dCents", "projectedLtsFee60dCents",
                                 "projectedLtsFee90dCents", "daysToLtsThreshold")
   VALUES ($1, $2, $3, NULL, 'IT', NOW(),
           0, 0, 10, 0, 0, 100, 1000, 1000, 1000, 10)
   RETURNING id`,
  [`fbaage-promo-${Date.now()}`, product.id, product.sku],
)
const fbaId = fbaIns.rows[0].id

const preEventsRes = await c.query(`SELECT COUNT(*) FROM "RetailEvent"`)
const preEvents = Number(preEventsRes.rows[0].count)

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
    // Ensure action handlers are registered (side-effect import).
    await import('./src/services/advertising/automation-action-handlers.ts')
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
console.log(`Evaluator summary: matches=${summary.totalMatches}`)

const postEventsRes = await c.query(`SELECT COUNT(*) FROM "RetailEvent"`)
const postEvents = Number(postEventsRes.rows[0].count)
if (postEvents === preEvents + 1) {
  pass(`one new RetailEvent created`)
} else {
  fail(`expected +1 RetailEvent, got delta=${postEvents - preEvents}`)
}

const newEvent = await c.query(
  `SELECT id, marketplace, "productType", source, name FROM "RetailEvent"
   WHERE source = 'AUTOMATION' AND marketplace = 'IT'
   ORDER BY "createdAt" DESC LIMIT 1`,
)
if (newEvent.rows.length === 1 && newEvent.rows[0].productType === product.productType) {
  pass(`RetailEvent scoped to productType=${product.productType} + marketplace=IT`)
} else {
  fail(`unexpected RetailEvent row: ${JSON.stringify(newEvent.rows)}`)
}

const action = await c.query(
  `SELECT action, value::float AS value FROM "RetailEventPriceAction" WHERE "eventId" = $1`,
  [newEvent.rows[0].id],
)
if (action.rows.length === 1 && action.rows[0].action === 'PERCENT_OFF' && action.rows[0].value === 15) {
  pass(`RetailEventPriceAction: PERCENT_OFF 15`)
} else {
  fail(`unexpected price action: ${JSON.stringify(action.rows)}`)
}

// Cleanup.
await c.query(`DELETE FROM "AutomationRule" WHERE id = $1`, [ruleId])
await c.query(`DELETE FROM "FbaStorageAge" WHERE id = $1`, [fbaId])
await c.query(`DELETE FROM "RetailEvent" WHERE id = $1`, [newEvent.rows[0].id])

await c.end()
process.exit(exitCode)
