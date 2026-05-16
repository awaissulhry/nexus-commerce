#!/usr/bin/env node
// AD.4 — Full integration: liquidate_aged_stock composite + rollback.
//
// Steps:
//   1. Pick a real Product with productType set
//   2. Run liquidateAgedStock() in dry-run — assert subActions describe
//      proposed writes without DB changes
//   3. Run liquidateAgedStock() in live mode — assert:
//      - new RetailEvent created (productType-scoped)
//      - AdvertisingActionLog rows written
//   4. Call rollbackByExecutionId() for synthetic execution → assert
//      RetailEvent isActive=false after rollback

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

const products = await c.query(
  `SELECT id, sku, "productType" FROM "Product" WHERE "productType" IS NOT NULL LIMIT 1`,
)
if (products.rows.length === 0) {
  console.log('No products with productType — skipping. (Seed at least one Product row first.)')
  process.exit(0)
}
const product = products.rows[0]
console.log(`Test product: ${product.sku} (productType=${product.productType})`)

const { spawnSync } = await import('node:child_process')
const apiRoot = path.join(here, '..', 'apps', 'api')

// Step 1: dry-run.
const dryResult = spawnSync(
  'node',
  [
    '--import',
    'tsx',
    '-e',
    `
    import { liquidateAgedStock } from './src/services/advertising/promotion-ad-coordinator.service.ts'
    const r = await liquidateAgedStock({
      productId: '${product.id}',
      marketplace: 'IT',
      discountPct: 15,
      durationDays: 14,
      boostPercent: 25,
      actor: 'user:verifier-liquidate',
      reason: 'verifier dry-run',
      dryRun: true,
      executionId: null,
    })
    console.log(JSON.stringify(r))
    `,
  ],
  { cwd: apiRoot, encoding: 'utf8' },
)
if (dryResult.status !== 0) {
  fail(`dry-run execution failed: ${dryResult.stderr}`)
  process.exit(1)
}
const dryOutcome = JSON.parse(dryResult.stdout.trim().split('\n').pop())
if (dryOutcome.ok && dryOutcome.subActions.length === 3) {
  pass(`dry-run returned 3 sub-actions with ok=true`)
} else {
  fail(`dry-run unexpected: ${JSON.stringify(dryOutcome)}`)
}
const allDryRun = dryOutcome.subActions.every((s) => s.output?.dryRun === true || s.output?.skipped)
if (allDryRun) pass(`every sub-action output flagged dryRun (no DB writes)`)
else fail(`dry-run sub-actions: ${JSON.stringify(dryOutcome.subActions)}`)

// Step 2: live mode.
const preEventsRes = await c.query(`SELECT COUNT(*) FROM "RetailEvent"`)
const preEvents = Number(preEventsRes.rows[0].count)

const liveResult = spawnSync(
  'node',
  [
    '--import',
    'tsx',
    '-e',
    `
    import { liquidateAgedStock } from './src/services/advertising/promotion-ad-coordinator.service.ts'
    const r = await liquidateAgedStock({
      productId: '${product.id}',
      marketplace: 'IT',
      discountPct: 15,
      durationDays: 14,
      boostPercent: 25,
      actor: 'user:verifier-liquidate',
      reason: 'verifier live run',
      dryRun: false,
      executionId: null,
    })
    console.log(JSON.stringify(r))
    `,
  ],
  { cwd: apiRoot, encoding: 'utf8' },
)
if (liveResult.status !== 0) {
  fail(`live execution failed: ${liveResult.stderr}`)
  process.exit(1)
}
const liveOutcome = JSON.parse(liveResult.stdout.trim().split('\n').pop())
console.log(
  `live outcome: retailEvent=${liveOutcome.retailEventId} paused=${liveOutcome.pausedCampaignIds.length} boosted=${liveOutcome.boostedCampaignIds.length} actionLogs=${liveOutcome.actionLogIds.length}`,
)
if (!liveOutcome.retailEventId) {
  fail(`expected a RetailEvent to be created`)
} else {
  pass(`RetailEvent created: ${liveOutcome.retailEventId}`)
}
const postEventsRes = await c.query(`SELECT COUNT(*) FROM "RetailEvent"`)
const postEvents = Number(postEventsRes.rows[0].count)
if (postEvents === preEvents + 1) pass(`+1 RetailEvent`)
else fail(`expected +1 RetailEvent, got delta=${postEvents - preEvents}`)

const logs = await c.query(
  `SELECT COUNT(*) FROM "AdvertisingActionLog" WHERE "userId" = 'user:verifier-liquidate'`,
)
if (Number(logs.rows[0].count) >= 1) pass(`AdvertisingActionLog rows written`)
else fail(`expected ≥ 1 AdvertisingActionLog row, got ${logs.rows[0].count}`)

// Step 3: rollback the RetailEvent specifically — confirm soft-disable.
if (liveOutcome.retailEventId) {
  // Walk AdvertisingActionLog rows for this RetailEvent, mark rolledBackAt
  // via the rollback service.
  const fakeExecRes = await c.query(
    `INSERT INTO "AutomationRule" (id, name, domain, trigger, conditions, actions, enabled, "dryRun", "createdBy", "updatedAt")
     VALUES ($1, $2, 'advertising', 'FBA_AGE_THRESHOLD_REACHED', '[]'::jsonb, '[]'::jsonb, false, true, 'verifier', NOW())
     RETURNING id`,
    [`verif-rb-rule-${Date.now()}`, `[verifier] rollback rule ${Date.now()}`],
  )
  const fakeRuleId = fakeExecRes.rows[0].id
  // Pretend the action log was emitted by this synthetic execution.
  const synthExecRes = await c.query(
    `INSERT INTO "AutomationRuleExecution" (id, "ruleId", "triggerData", "actionResults", "dryRun", status, "startedAt", "finishedAt")
     VALUES ($1, $2, '{}'::jsonb, '[]'::jsonb, false, 'SUCCESS', NOW() - INTERVAL '1 minute', NOW())
     RETURNING id`,
    [`verif-rb-exec-${Date.now()}`, fakeRuleId],
  )
  const synthExecId = synthExecRes.rows[0].id
  // Re-tag the action log rows so the rollback walker finds them.
  await c.query(
    `UPDATE "AdvertisingActionLog" SET "executionId" = $1
     WHERE "userId" = 'user:verifier-liquidate' AND "rolledBackAt" IS NULL`,
    [synthExecId],
  )
  const rbResult = spawnSync(
    'node',
    [
      '--import',
      'tsx',
      '-e',
      `
      import { rollbackByExecutionId } from './src/services/advertising/rollback.service.ts'
      const r = await rollbackByExecutionId({ executionId: '${synthExecId}', actor: 'user:verifier-rollback', reason: 'verifier rollback' })
      console.log(JSON.stringify(r))
      `,
    ],
    { cwd: apiRoot, encoding: 'utf8' },
  )
  if (rbResult.status !== 0) {
    fail(`rollback execution failed: ${rbResult.stderr}`)
  } else {
    const rb = JSON.parse(rbResult.stdout.trim().split('\n').pop())
    console.log(`rollback: reversed=${rb.reversed} skipped=${rb.skipped} failed=${rb.failed}`)
    const eventAfter = await c.query(
      `SELECT "isActive" FROM "RetailEvent" WHERE id = $1`,
      [liveOutcome.retailEventId],
    )
    if (eventAfter.rows[0]?.isActive === false) {
      pass(`RetailEvent.isActive set to false after rollback`)
    } else {
      fail(`expected RetailEvent.isActive=false, got ${eventAfter.rows[0]?.isActive}`)
    }
  }
  // Cleanup synth execution + rule.
  await c.query(`DELETE FROM "AutomationRuleExecution" WHERE id = $1`, [synthExecId])
  await c.query(`DELETE FROM "AutomationRule" WHERE id = $1`, [fakeRuleId])
}

// Cleanup test artifacts.
if (liveOutcome.retailEventId) {
  await c.query(`DELETE FROM "RetailEvent" WHERE id = $1`, [liveOutcome.retailEventId])
}
await c.query(`DELETE FROM "AdvertisingActionLog" WHERE "userId" = 'user:verifier-liquidate' OR "userId" = 'user:verifier-rollback'`)

await c.end()
process.exit(exitCode)
