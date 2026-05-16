#!/usr/bin/env node
// AD.2 — Verifies bulk AdTarget bid updates write one CampaignBidHistory
// row per target, all with distinct entityIds and the same changedBy.

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

const targetsRows = await c.query(
  `SELECT id, "bidCents" FROM "AdTarget" WHERE "externalTargetId" LIKE 'SANDBOX-T-%' LIMIT 5`,
)
if (targetsRows.rows.length < 2) {
  console.error('Need at least 2 sandbox targets — run check-ads-sandbox.mjs first.')
  process.exit(1)
}
const targets = targetsRows.rows
console.log(`Testing bulk-bid on ${targets.length} target(s)`)

const { spawnSync } = await import('node:child_process')
const apiRoot = path.join(here, '..', 'apps', 'api')
const runResult = spawnSync(
  'node',
  [
    '--import',
    'tsx',
    '-e',
    `
    import { bulkUpdateAdTargetBids } from './src/services/advertising/ads-mutation.service.ts'
    const entries = ${JSON.stringify(targets.map((t) => ({ adTargetId: t.id, bidCents: t.bidCents + 10 })))}
    const result = await bulkUpdateAdTargetBids({
      entries,
      actor: 'user:check-bulk-bid',
      reason: 'verifier — bulk +€0.10',
    })
    console.log(JSON.stringify({ applied: result.applied, skipped: result.skipped, failed: result.failed, chunks: result.chunks }))
    `,
  ],
  { cwd: apiRoot, encoding: 'utf8' },
)
if (runResult.status !== 0) {
  fail(`service execution failed: ${runResult.stderr}`)
  process.exit(1)
}
const lines = runResult.stdout.trim().split('\n')
const result = JSON.parse(lines[lines.length - 1])
console.log(`Result: applied=${result.applied} skipped=${result.skipped} failed=${result.failed} chunks=${result.chunks}`)

if (result.applied !== targets.length) {
  fail(`expected applied=${targets.length}, got ${result.applied}`)
}

// Distinct audit rows.
const hist = await c.query(
  `SELECT "entityId", field, "changedBy" FROM "CampaignBidHistory"
   WHERE "changedBy" = 'user:check-bulk-bid' AND "entityType" = 'AD_TARGET'
   ORDER BY "changedAt" DESC LIMIT ${targets.length}`,
)
if (hist.rows.length === targets.length) {
  pass(`${hist.rows.length} audit rows written for bulk operation`)
} else {
  fail(`expected ${targets.length} audit rows, got ${hist.rows.length}`)
}

const entityIds = new Set(hist.rows.map((r) => r.entityId))
if (entityIds.size === targets.length) {
  pass(`distinct entityIds — one audit row per target`)
} else {
  fail(`expected ${targets.length} distinct entityIds, got ${entityIds.size}`)
}

const allChangedBy = hist.rows.every((r) => r.changedBy === 'user:check-bulk-bid')
if (allChangedBy) {
  pass(`all rows share changedBy=user:check-bulk-bid`)
} else {
  fail(`mixed changedBy values`)
}

const allBidField = hist.rows.every((r) => r.field === 'bid')
if (allBidField) {
  pass(`all rows have field=bid`)
} else {
  fail(`unexpected field values`)
}

await c.end()
process.exit(exitCode)
