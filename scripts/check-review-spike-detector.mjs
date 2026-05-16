#!/usr/bin/env node
// SR.1 — Verifies spike detector creates a ReviewSpike row when 7d
// negative-rate spikes vs 28d baseline.
//
//   1. Pick a real Product to attach reviews to
//   2. Seed ReviewCategoryRate rows: 28d baseline of 1 negative / 20 total,
//      7d window: 5 negatives / 8 total → ~16.6× spike
//   3. Run runSpikeDetectorOnce
//   4. Assert exactly 1 new ReviewSpike row for this product/category

import dotenv from 'dotenv'
import path from 'path'
import { fileURLToPath } from 'url'
import pg from 'pg'

const here = path.dirname(fileURLToPath(import.meta.url))
dotenv.config({ path: path.join(here, '..', '.env') })

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

const products = await c.query(`SELECT id, sku FROM "Product" LIMIT 1`)
if (products.rows.length === 0) {
  console.log('No products in DB — skipping. Seed at least one Product first.')
  process.exit(0)
}
const product = products.rows[0]
const TEST_MARKETPLACE = 'IT'
const TEST_CATEGORY = 'FIT_SIZING'

const ts = Date.now()
const cleanup = []

// Helper: seed a ReviewCategoryRate row for a specific date.
async function seedRate(date, total, negative) {
  const id = `verif-rate-${ts}-${date.toISOString().slice(0, 10)}`
  await c.query(
    `INSERT INTO "ReviewCategoryRate" (id, "productId", marketplace, category, date, total, negative, "updatedAt")
     VALUES ($1, $2, $3, $4, $5::date, $6, $7, NOW())
     ON CONFLICT ("productId", marketplace, category, date) DO UPDATE
       SET total = "ReviewCategoryRate".total + EXCLUDED.total,
           negative = "ReviewCategoryRate".negative + EXCLUDED.negative`,
    [id, product.id, TEST_MARKETPLACE, TEST_CATEGORY, date, total, negative],
  )
  cleanup.push(['ReviewCategoryRate-cleanup', null])
}

// 28d baseline: 1 negative / 20 total spread across 25-15 days ago.
for (let dayOffset = 15; dayOffset <= 25; dayOffset++) {
  await seedRate(new Date(Date.now() - dayOffset * 24 * 60 * 60 * 1000), 2, 0)
}
await seedRate(new Date(Date.now() - 16 * 24 * 60 * 60 * 1000), 0, 1)

// 7d spike: 5 negatives / 8 total in last 5 days.
for (let dayOffset = 1; dayOffset <= 5; dayOffset++) {
  const negs = dayOffset <= 3 ? 1 : 1
  await seedRate(new Date(Date.now() - dayOffset * 24 * 60 * 60 * 1000), 2, negs)
}

const preSpikes = await c.query(
  `SELECT COUNT(*) FROM "ReviewSpike" WHERE "productId" = $1 AND marketplace = $2 AND category = $3 AND status = 'OPEN'`,
  [product.id, TEST_MARKETPLACE, TEST_CATEGORY],
)

const { spawnSync } = await import('node:child_process')
const apiRoot = path.join(here, '..', 'apps', 'api')
const runResult = spawnSync(
  'node',
  [
    '--import',
    'tsx',
    '-e',
    `
    import { runSpikeDetectorOnce } from './src/services/reviews/spike-detector.service.ts'
    const r = await runSpikeDetectorOnce()
    console.log(JSON.stringify(r))
    `,
  ],
  { cwd: apiRoot, encoding: 'utf8' },
)
if (runResult.status !== 0) {
  fail(`detector failed: ${runResult.stderr}`)
  await teardown()
  process.exit(1)
}
const summary = JSON.parse(runResult.stdout.trim().split('\n').pop())
console.log(`Detector: cohorts=${summary.cohortsScanned} spikes=${summary.spikesDetected}`)

const postSpikes = await c.query(
  `SELECT id, "spikeMultiplier"::float AS mult, "rate7dNumerator", "rate7dDenominator", "rate28dNumerator", "rate28dDenominator" FROM "ReviewSpike" WHERE "productId" = $1 AND marketplace = $2 AND category = $3 AND status = 'OPEN' ORDER BY "detectedAt" DESC`,
  [product.id, TEST_MARKETPLACE, TEST_CATEGORY],
)
const newRows = postSpikes.rows.length - Number(preSpikes.rows[0].count)
if (newRows === 1) {
  pass(`exactly 1 new ReviewSpike created for ${product.sku}/${TEST_MARKETPLACE}/${TEST_CATEGORY}`)
  const row = postSpikes.rows[0]
  console.log(
    `   spike: 7d=${row.rate7dNumerator}/${row.rate7dDenominator} · 28d=${row.rate28dNumerator}/${row.rate28dDenominator} · multiplier=${row.mult?.toFixed(1)}×`,
  )
  if (row.mult >= 2.0) {
    pass(`spikeMultiplier >= 2.0 (${row.mult.toFixed(1)}×)`)
  } else {
    fail(`expected spikeMultiplier >= 2.0, got ${row.mult}`)
  }
} else {
  fail(`expected 1 new spike, got delta=${newRows}`)
}

// Re-running should NOT create a duplicate.
const rerunResult = spawnSync(
  'node',
  [
    '--import',
    'tsx',
    '-e',
    `
    import { runSpikeDetectorOnce } from './src/services/reviews/spike-detector.service.ts'
    const r = await runSpikeDetectorOnce()
    console.log(JSON.stringify(r))
    `,
  ],
  { cwd: apiRoot, encoding: 'utf8' },
)
const rerunSummary = JSON.parse(rerunResult.stdout.trim().split('\n').pop())
if (rerunSummary.spikesSkippedDuplicate >= 1) {
  pass(`re-run dedupes the open spike (skipped=${rerunSummary.spikesSkippedDuplicate})`)
} else {
  fail(`expected re-run to skip duplicate, got ${JSON.stringify(rerunSummary)}`)
}

await teardown()
await c.end()
process.exit(exitCode)

async function teardown() {
  // Hard-clean the seeded rate rows + new spike rows for this cohort.
  await c.query(
    `DELETE FROM "ReviewCategoryRate" WHERE "productId" = $1 AND marketplace = $2 AND category = $3`,
    [product.id, TEST_MARKETPLACE, TEST_CATEGORY],
  )
  await c.query(
    `DELETE FROM "ReviewSpike" WHERE "productId" = $1 AND marketplace = $2 AND category = $3`,
    [product.id, TEST_MARKETPLACE, TEST_CATEGORY],
  )
}
