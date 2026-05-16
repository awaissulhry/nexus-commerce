#!/usr/bin/env node
// AD.1 — Verifies true-profit-rollup.service.
//
// What it does:
//   1. Picks a real Product + Order that exists today (read-only)
//   2. Runs runTrueProfitRollupOnce() over the last 30 days
//   3. Asserts at least 1 ProductProfitDaily row landed
//   4. For rows with coverage.hasCostPrice=true, asserts:
//        cogsCents = costPriceCents × unitsSold (within 1¢ rounding)
//        trueProfitCents = grossRevenueCents - cogsCents - referralFeesCents
//   5. Asserts trueProfitMarginPct math holds when grossRevenueCents > 0

import dotenv from 'dotenv'
import path from 'path'
import { fileURLToPath } from 'url'
import pg from 'pg'

const here = path.dirname(fileURLToPath(import.meta.url))
dotenv.config({ path: path.join(here, '..', '.env') })

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

// Snapshot pre-state.
const pre = await c.query('SELECT COUNT(*) FROM "ProductProfitDaily"')
console.log(`Pre-test ProductProfitDaily rows: ${pre.rows[0].count}`)

const { spawnSync } = await import('node:child_process')
const apiRoot = path.join(here, '..', 'apps', 'api')
const runResult = spawnSync(
  'node',
  [
    '--import',
    'tsx',
    '-e',
    `
    import { runTrueProfitRollupOnce, summarizeTrueProfitRollup } from './src/services/advertising/true-profit-rollup.service.ts'
    const from = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000)
    const to = new Date(Date.now() - 1 * 24 * 60 * 60 * 1000)
    const s = await runTrueProfitRollupOnce({ fromDate: from, toDate: to })
    console.log(JSON.stringify(s))
    `,
  ],
  { cwd: apiRoot, encoding: 'utf8' },
)
if (runResult.status !== 0) {
  fail(`service execution failed: ${runResult.stderr}`)
  process.exit(1)
}
const lines = runResult.stdout.trim().split('\n')
const summary = JSON.parse(lines[lines.length - 1])
console.log(`Service summary: dates=${summary.datesProcessed.length} markets=${summary.marketplacesProcessed.join(',')} rows=${summary.rowsUpserted}`)

// If there are no orders in the last 30 days we can't assert on row creation.
const orderCheck = await c.query(
  `SELECT COUNT(*) FROM "Order" WHERE "marketplace" IS NOT NULL AND "purchaseDate" >= NOW() - INTERVAL '30 days' AND status NOT IN ('CANCELLED')`,
)
const hasRecentOrders = Number(orderCheck.rows[0].count) > 0

if (hasRecentOrders) {
  if (summary.rowsUpserted >= 1) {
    pass(`upserted ≥ 1 ProductProfitDaily row`)
  } else {
    fail(`expected ≥ 1 row given ${orderCheck.rows[0].count} recent orders, got 0`)
  }
} else {
  console.log(`  · no recent orders with marketplace — math assertions skipped`)
}

// Pull a sample row and verify the math.
const sample = await c.query(
  `SELECT pp.*, p.sku, p."costPrice"
   FROM "ProductProfitDaily" pp
   JOIN "Product" p ON p.id = pp."productId"
   WHERE pp."unitsSold" > 0 AND pp."grossRevenueCents" > 0
   ORDER BY pp."date" DESC
   LIMIT 5`,
)

let mathChecks = 0
for (const row of sample.rows) {
  const cov = row.coverage || {}
  // True-profit identity (independent of coverage).
  const expectedTrueProfit =
    row.grossRevenueCents - row.cogsCents - row.referralFeesCents
  if (Math.abs(row.trueProfitCents - expectedTrueProfit) > 1) {
    fail(
      `row ${row.id} trueProfit mismatch: expected ${expectedTrueProfit}, got ${row.trueProfitCents}`,
    )
  } else {
    mathChecks += 1
  }
  // Margin identity.
  if (row.grossRevenueCents > 0 && row.trueProfitMarginPct != null) {
    const expectedMargin = row.trueProfitCents / row.grossRevenueCents
    if (Math.abs(Number(row.trueProfitMarginPct) - expectedMargin) > 0.0001) {
      fail(`row ${row.id} margin mismatch`)
    }
  }
  // COGS identity when coverage says we had cost data.
  if (cov.hasCostPrice && row.costPrice != null) {
    const expectedCogs = Math.round(Number(row.costPrice) * 100) * row.unitsSold
    if (Math.abs(row.cogsCents - expectedCogs) > 1) {
      fail(`row ${row.id} cogs mismatch: expected ${expectedCogs}, got ${row.cogsCents}`)
    }
  }
}
if (mathChecks > 0) {
  pass(`true-profit identity holds on ${mathChecks} sampled rows`)
}

await c.end()
process.exit(exitCode)
