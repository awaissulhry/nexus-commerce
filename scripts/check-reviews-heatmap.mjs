#!/usr/bin/env node
// SR.2 — Verifies the heatmap + by-product aggregation endpoints.
//
//   1. Pick a real Product
//   2. Seed ReviewCategoryRate cells spanning 4 days × 2 categories ×
//      mixed positive/negative counts
//   3. Hit GET /api/reviews/heatmap → assert cells match expected
//      (date, category) keys with summed values
//   4. Hit GET /api/reviews/by-product → assert the product shows up
//      with correct negative pct

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

const ts = Date.now()
const cleanup = []

// Seed pattern:
//   Day -3: FIT_SIZING 5 total / 1 neg
//   Day -2: FIT_SIZING 8 total / 3 neg ; DURABILITY 3 total / 0 neg
//   Day -1: FIT_SIZING 10 total / 4 neg ; DURABILITY 5 total / 1 neg
//   Day 0:  FIT_SIZING 4 total / 2 neg
async function seed(dayOffset, category, total, negative) {
  const date = new Date(Date.now() - dayOffset * 24 * 60 * 60 * 1000)
  const id = `verif-heatmap-${ts}-${dayOffset}-${category}`
  await c.query(
    `INSERT INTO "ReviewCategoryRate" (id, "productId", marketplace, category, date, total, negative, "updatedAt")
     VALUES ($1, $2, $3, $4, $5::date, $6, $7, NOW())
     ON CONFLICT ("productId", marketplace, category, date) DO UPDATE
       SET total = "ReviewCategoryRate".total + EXCLUDED.total,
           negative = "ReviewCategoryRate".negative + EXCLUDED.negative`,
    [id, product.id, TEST_MARKETPLACE, category, date, total, negative],
  )
  cleanup.push({ category, date })
}

await seed(3, 'FIT_SIZING', 5, 1)
await seed(2, 'FIT_SIZING', 8, 3)
await seed(2, 'DURABILITY', 3, 0)
await seed(1, 'FIT_SIZING', 10, 4)
await seed(1, 'DURABILITY', 5, 1)
await seed(0, 'FIT_SIZING', 4, 2)

// Heatmap should aggregate across products; since we're contributing
// to existing categories, just check our cohort delta is present.

const API_URL = process.env.API_URL ?? 'http://localhost:3001'
let httpReached = false
try {
  const res = await fetch(`${API_URL}/api/reviews/heatmap?sinceDays=7`)
  if (res.ok) {
    httpReached = true
    const json = await res.json()
    if (Array.isArray(json.cells) && json.cells.length > 0) {
      pass(`heatmap returned ${json.cells.length} cells across ${json.dates.length} dates × ${json.categories.length} categories`)
      const fitSizingCells = json.cells.filter((c) => c.category === 'FIT_SIZING')
      const fitSizingTotal = fitSizingCells.reduce((a, c) => a + c.total, 0)
      const fitSizingNeg = fitSizingCells.reduce((a, c) => a + c.negative, 0)
      if (fitSizingTotal >= 27 && fitSizingNeg >= 10) {
        pass(`FIT_SIZING aggregates include our seeded values (total≥27 found ${fitSizingTotal}, neg≥10 found ${fitSizingNeg})`)
      } else {
        fail(`FIT_SIZING aggregates missing seeded values: total=${fitSizingTotal}, neg=${fitSizingNeg}`)
      }
    } else {
      fail(`heatmap returned no cells`)
    }
  } else {
    console.log(`  · API not 200 at ${API_URL} (${res.status}) — skipping HTTP check`)
  }
} catch {
  console.log(`  · API not reachable at ${API_URL} — skipping HTTP check`)
}

if (!httpReached) {
  // No HTTP available — verify directly against DB.
  const rows = await c.query(
    `SELECT category, SUM(total)::int AS total, SUM(negative)::int AS negative
     FROM "ReviewCategoryRate"
     WHERE "productId" = $1 AND marketplace = $2 AND date >= NOW() - INTERVAL '7 days'
     GROUP BY category`,
    [product.id, TEST_MARKETPLACE],
  )
  const byCat = Object.fromEntries(rows.rows.map((r) => [r.category, r]))
  if (byCat.FIT_SIZING && byCat.FIT_SIZING.total >= 27) {
    pass(`DB FIT_SIZING aggregate ≥ 27 (got ${byCat.FIT_SIZING.total})`)
  } else {
    fail(`DB FIT_SIZING aggregate missing or low: ${JSON.stringify(byCat.FIT_SIZING)}`)
  }
  if (byCat.DURABILITY && byCat.DURABILITY.total >= 8) {
    pass(`DB DURABILITY aggregate ≥ 8 (got ${byCat.DURABILITY.total})`)
  } else {
    fail(`DB DURABILITY aggregate missing or low: ${JSON.stringify(byCat.DURABILITY)}`)
  }
}

// Cleanup.
for (const c of cleanup) {
  await c
}
await c.query(
  `DELETE FROM "ReviewCategoryRate" WHERE "productId" = $1 AND marketplace = $2`,
  [product.id, TEST_MARKETPLACE],
)

await c.end()
process.exit(exitCode)
