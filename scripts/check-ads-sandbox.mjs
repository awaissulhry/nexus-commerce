#!/usr/bin/env node
// AD.1 — Verifies ads-sync.service end-to-end in sandbox mode.
//
// What it does:
//   1. Sets NEXUS_AMAZON_ADS_MODE=sandbox
//   2. Runs runAdsSyncOnce()
//   3. Asserts at least 2 campaigns, 2 ad-groups, 1 target landed in DB
//   4. Asserts at least 1 productAd was created with non-null asin
//   5. Asserts lastSyncStatus=SUCCESS on every synced campaign

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

const { spawnSync } = await import('node:child_process')
const apiRoot = path.join(here, '..', 'apps', 'api')
const runResult = spawnSync(
  'node',
  [
    '--import',
    'tsx',
    '-e',
    `
    import { runAdsSyncOnce, summarizeAdsSync } from './src/services/advertising/ads-sync.service.ts'
    const s = await runAdsSyncOnce()
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
console.log(`Service summary: mode=${summary.mode} profiles=${summary.profileCount} campaigns=${summary.campaigns.upserted}+${summary.campaigns.skipped} adGroups=${summary.adGroups.upserted}+${summary.adGroups.skipped} targets=${summary.targets.upserted}+${summary.targets.skipped} productAds=${summary.productAds.upserted}+${summary.productAds.skipped}`)

if (summary.mode !== 'sandbox') {
  fail(`expected mode=sandbox, got ${summary.mode}`)
}

const camps = await c.query(
  `SELECT COUNT(*) FROM "Campaign" WHERE "externalCampaignId" LIKE 'SANDBOX-CAMP-%'`,
)
if (Number(camps.rows[0].count) >= 2) {
  pass(`≥ 2 sandbox campaigns persisted (${camps.rows[0].count})`)
} else {
  fail(`expected ≥ 2 sandbox campaigns, got ${camps.rows[0].count}`)
}

const ags = await c.query(
  `SELECT COUNT(*) FROM "AdGroup" WHERE "externalAdGroupId" LIKE 'SANDBOX-AG-%'`,
)
if (Number(ags.rows[0].count) >= 2) {
  pass(`≥ 2 sandbox ad-groups persisted (${ags.rows[0].count})`)
} else {
  fail(`expected ≥ 2 sandbox ad-groups, got ${ags.rows[0].count}`)
}

const targets = await c.query(
  `SELECT COUNT(*) FROM "AdTarget" WHERE "externalTargetId" LIKE 'SANDBOX-T-%'`,
)
if (Number(targets.rows[0].count) >= 1) {
  pass(`≥ 1 sandbox target persisted (${targets.rows[0].count})`)
} else {
  fail(`expected ≥ 1 sandbox target, got ${targets.rows[0].count}`)
}

const pa = await c.query(
  `SELECT COUNT(*) FROM "AdProductAd" WHERE "externalAdId" LIKE 'SANDBOX-PA-%' AND "asin" IS NOT NULL`,
)
if (Number(pa.rows[0].count) >= 1) {
  pass(`≥ 1 sandbox productAd with asin (${pa.rows[0].count})`)
} else {
  fail(`expected ≥ 1 sandbox productAd with asin, got ${pa.rows[0].count}`)
}

const okStatus = await c.query(
  `SELECT COUNT(*) FROM "Campaign" WHERE "externalCampaignId" LIKE 'SANDBOX-CAMP-%' AND "lastSyncStatus" = 'SUCCESS'`,
)
if (Number(okStatus.rows[0].count) === Number(camps.rows[0].count)) {
  pass(`every sandbox campaign has lastSyncStatus=SUCCESS`)
} else {
  fail(`expected all campaigns SUCCESS, got ${okStatus.rows[0].count}/${camps.rows[0].count}`)
}

await c.end()
process.exit(exitCode)
