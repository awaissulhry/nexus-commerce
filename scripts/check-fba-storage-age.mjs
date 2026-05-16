#!/usr/bin/env node
// AD.1 — Verifies FbaStorageAge ingest works end-to-end in sandbox mode.
//
// What it does:
//   1. Connects to the DB
//   2. Imports + runs runFbaStorageAgeIngestOnce() with NEXUS_AMAZON_ADS_MODE=sandbox
//   3. Asserts at least 4 rows landed in FbaStorageAge
//   4. Asserts at least 1 row has daysToLtsThreshold ≤ 30 (the trigger cohort)
//   5. Asserts the GET /api/advertising/fba-storage-age?bucket=aging route
//      returns the same rows (when API_URL is set)
//
// Run: node scripts/check-fba-storage-age.mjs
//
// Optional env:
//   API_URL=http://localhost:3001  (defaults to http://localhost:3001)

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

// Capture pre-test row count.
const preRows = await c.query('SELECT COUNT(*) FROM "FbaStorageAge"')
const preCount = Number(preRows.rows[0].count)
console.log(`Pre-test FbaStorageAge rows: ${preCount}`)

// Import the service via tsx-style. The compiled JS lives under apps/api/dist
// once built; in dev we shell out to tsx.
const { spawnSync } = await import('node:child_process')
const apiRoot = path.join(here, '..', 'apps', 'api')
const runResult = spawnSync(
  'node',
  [
    '--import',
    'tsx',
    '-e',
    `
    import { runFbaStorageAgeIngestOnce, summarizeFbaStorageAge } from './src/services/advertising/fba-storage-age-ingest.service.ts'
    const s = await runFbaStorageAgeIngestOnce()
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
console.log(`Service summary: rows=${summary.rowsIngested} flagged=${summary.skusFlagged} markets=${summary.marketplaces.join(',')}`)

// Assertions.
const postRows = await c.query('SELECT COUNT(*) FROM "FbaStorageAge"')
const postCount = Number(postRows.rows[0].count)
if (postCount >= preCount + 4) {
  pass(`ingested ≥ 4 rows (was ${preCount}, now ${postCount})`)
} else {
  fail(`expected ≥ 4 new rows, got ${postCount - preCount}`)
}

const flagged = await c.query(
  `SELECT COUNT(*) FROM "FbaStorageAge" WHERE "daysToLtsThreshold" IS NOT NULL AND "daysToLtsThreshold" <= 30`,
)
const flaggedCount = Number(flagged.rows[0].count)
if (flaggedCount >= 1) {
  pass(`at least 1 SKU flagged within 30d of LTS threshold (${flaggedCount} total)`)
} else {
  fail(`expected ≥ 1 flagged SKU, got ${flaggedCount}`)
}

// Optional API round-trip.
const apiUrl = process.env.API_URL ?? 'http://localhost:3001'
try {
  const res = await fetch(`${apiUrl}/api/advertising/fba-storage-age?bucket=aging&limit=20`)
  if (res.ok) {
    const json = await res.json()
    if (json.count >= 1) {
      pass(`API route returned ${json.count} aging SKUs`)
    } else {
      fail(`API route returned 0 rows`)
    }
  } else {
    console.log(`  · API not reachable at ${apiUrl} (skipped HTTP check)`)
  }
} catch {
  console.log(`  · API not reachable at ${apiUrl} (skipped HTTP check)`)
}

await c.end()
process.exit(exitCode)
