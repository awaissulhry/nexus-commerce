#!/usr/bin/env node
// Phase 3d — Cron-flag audit. Crosses (local .env enable flag) × (production
// CronRun history last 7 days) to spot ingestion jobs that "should be running
// but aren't" or vice versa. Read-only.

import dotenv from 'dotenv'
import { fileURLToPath } from 'url'
import path from 'path'
import pg from 'pg'

const here = path.dirname(fileURLToPath(import.meta.url))
dotenv.config({ path: path.join(here, '..', '.env') })

const c = new pg.Client({ connectionString: process.env.DATABASE_URL })
await c.connect()

const cronTargets = [
  { job: 'amazon-orders-sync',     envFlag: 'NEXUS_ENABLE_AMAZON_ORDERS_CRON',    purpose: 'Pull new Amazon orders (15min)' },
  { job: 'amazon-financial-sync',  envFlag: 'NEXUS_ENABLE_AMAZON_FINANCIAL_CRON', purpose: 'Pull Amazon financial events (daily 02:00)' },
  { job: 'amazon-inventory-sync',  envFlag: 'NEXUS_ENABLE_AMAZON_INVENTORY_CRON', purpose: 'Pull FBA inventory (15min)' },
  { job: 'amazon-returns-poll',    envFlag: 'NEXUS_ENABLE_AMAZON_RETURNS_POLL',   purpose: 'Pull Amazon returns (hourly)' },
  { job: 'amazon-mcf-status',      envFlag: null,                                  purpose: 'MCF (multi-channel fulfillment) status sync' },
  { job: 'ebay-orders-sync',       envFlag: 'NEXUS_ENABLE_EBAY_ORDERS_CRON',      purpose: 'Pull new eBay orders (15min, 7d window)' },
  { job: 'ebay-financial-sync',    envFlag: 'NEXUS_ENABLE_EBAY_FINANCIAL_CRON',   purpose: 'Pull eBay financial events (daily 03:30)' },
  { job: 'ebay-token-refresh',     envFlag: null,                                  purpose: 'Keep eBay OAuth token fresh (6h)' },
  { job: 'ads-sync',               envFlag: 'NEXUS_ENABLE_AMAZON_ADS_CRON',       purpose: 'Amazon Ads reports + structure sync (multi-tick)' },
  { job: 'ads-report-ingest',      envFlag: 'NEXUS_ENABLE_AMAZON_ADS_CRON',       purpose: 'Ingest completed Amazon Ads reports (15min)' },
  { job: 'ads-v1-export-ingest',   envFlag: 'NEXUS_ENABLE_AMAZON_ADS_CRON',       purpose: 'Ingest Amazon Ads v1 structure exports (5min)' },
  { job: 'shopify-sync',           envFlag: null,                                  purpose: 'Shopify products + orders sync (not wired)' },
]

const r = await c.query(`
  SELECT "jobName",
         count(*) AS runs,
         count(*) FILTER (WHERE status='SUCCESS') AS ok,
         count(*) FILTER (WHERE status='FAILED') AS failed,
         count(*) FILTER (WHERE status='RUNNING') AS running,
         max("startedAt") AS last_run
  FROM "CronRun"
  WHERE "startedAt" > NOW() - INTERVAL '7 days'
  GROUP BY "jobName"
`)
const byJob = new Map(r.rows.map(row => [row.jobName, row]))

console.log(`\n━━━ Cron flag audit (local .env × production CronRun last 7d) ━━━━━━━━━`)
console.log(`Job                          Flag (local .env)        Set?  Ran(7d)  Status`)
console.log(`────────────────────────────  ──────────────────────  ────  ───────  ──────`)

for (const { job, envFlag, purpose } of cronTargets) {
  const flagSet = envFlag ? (process.env[envFlag] === '1') : null
  const history = byJob.get(job)
  const runs = history ? Number(history.runs) : 0
  const failed = history ? Number(history.failed) : 0
  const lastRun = history ? new Date(history.last_run).toISOString().slice(0, 16) : 'never'

  const flagCol = envFlag ? envFlag.replace('NEXUS_ENABLE_', '') : '(always-on)'
  const setCol = envFlag === null ? '—' : (flagSet ? '  YES ' : '  no  ')
  const runsCol = String(runs).padStart(6)
  let status = '✅'
  if (envFlag && flagSet && runs === 0) status = '❌ should run but did not'
  else if (envFlag && !flagSet && runs > 0) status = '⚠  ran despite local flag off (production env differs?)'
  else if (envFlag && !flagSet && runs === 0) status = '· (disabled)'
  else if (runs === 0 && envFlag === null) status = '⚠  never ran (not scheduled or no-op)'
  else if (failed > 0) status = `⚠ ${failed} failures`

  console.log(`${job.padEnd(28)} ${flagCol.padEnd(22)}  ${setCol}  ${runsCol}  ${status}`)
}

console.log(`\n  Last run column omitted; query CronRun for details. Status logic:`)
console.log(`    ✅ flag matches behavior`)
console.log(`    ⚠  flag/behavior mismatch (your local .env may not reflect production)`)
console.log(`    ❌ enabled but silently not running — investigate isConfigured() or schedule`)

// ── Specifically: did Amazon ingestion crons ever actually fire successfully?
console.log(`\n━━━ Sample: last 5 amazon-orders-sync + ebay-orders-sync runs ━━━`)
const sample = await c.query(`
  SELECT "jobName", status, "startedAt"::timestamp(0) AS started, "outputSummary"
  FROM "CronRun"
  WHERE "jobName" IN ('amazon-orders-sync', 'ebay-orders-sync', 'amazon-financial-sync', 'ebay-financial-sync', 'amazon-returns-poll')
  ORDER BY "startedAt" DESC
  LIMIT 10
`)
if (sample.rows.length === 0) {
  console.log(`  (none of these jobs has any CronRun row ever — they were never scheduled in production, or always early-returned before recordCronRun)`)
} else {
  console.table(sample.rows)
}

await c.end()
