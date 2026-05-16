#!/usr/bin/env node
// AD.2 — Verifies ads-mutation.service writes the right artifacts:
//   1. Campaign row updated locally
//   2. OutboundSyncQueue row created with syncType=AD_BUDGET_UPDATE,
//      targetChannel=AMAZON, holdUntil ≈ NOW + 5 min, syncStatus=PENDING
//   3. CampaignBidHistory audit row written

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

// Use first existing sandbox campaign as the subject.
const campRows = await c.query(
  `SELECT id, "dailyBudget"::float AS budget, status, name FROM "Campaign" WHERE "externalCampaignId" LIKE 'SANDBOX-CAMP-%' LIMIT 1`,
)
if (campRows.rows.length === 0) {
  console.error('No sandbox campaigns found — run check-ads-sandbox.mjs first.')
  process.exit(1)
}
const camp = campRows.rows[0]
console.log(`Test subject: ${camp.name} (budget=€${camp.budget.toFixed(2)}, status=${camp.status})`)

// Capture pre-state counts.
const pre = await c.query(
  `SELECT
     (SELECT COUNT(*) FROM "OutboundSyncQueue" WHERE "syncType" = 'AD_BUDGET_UPDATE') AS q,
     (SELECT COUNT(*) FROM "CampaignBidHistory" WHERE "campaignId" = $1) AS h`,
  [camp.id],
)

// Invoke the service.
const { spawnSync } = await import('node:child_process')
const apiRoot = path.join(here, '..', 'apps', 'api')
const runResult = spawnSync(
  'node',
  [
    '--import',
    'tsx',
    '-e',
    `
    import { updateCampaignWithSync } from './src/services/advertising/ads-mutation.service.ts'
    const result = await updateCampaignWithSync({
      campaignId: '${camp.id}',
      patch: { dailyBudget: ${camp.budget + 5} },
      actor: 'user:check-mutation-script',
      reason: 'verifier script — bump budget by €5',
    })
    console.log(JSON.stringify(result))
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
console.log(`Result: ok=${result.ok} outboundQueueId=${result.outboundQueueId} bidHistoryIds=${result.bidHistoryIds.length}`)

if (!result.ok || !result.outboundQueueId) {
  fail(`expected ok=true with outboundQueueId, got ${JSON.stringify(result)}`)
  process.exit(exitCode)
}

// Assertion 1: Campaign row updated locally.
const post = await c.query(
  `SELECT "dailyBudget"::float AS budget FROM "Campaign" WHERE id = $1`,
  [camp.id],
)
const newBudget = post.rows[0].budget
if (Math.abs(newBudget - (camp.budget + 5)) < 0.01) {
  pass(`Campaign.dailyBudget updated: €${camp.budget.toFixed(2)} → €${newBudget.toFixed(2)}`)
} else {
  fail(`expected budget €${(camp.budget + 5).toFixed(2)}, got €${newBudget.toFixed(2)}`)
}

// Assertion 2: OutboundSyncQueue row created.
const queueRow = await c.query(
  `SELECT id, "syncType", "syncStatus", "targetChannel", "holdUntil", payload FROM "OutboundSyncQueue" WHERE id = $1`,
  [result.outboundQueueId],
)
if (queueRow.rows.length === 1) {
  const row = queueRow.rows[0]
  pass(`OutboundSyncQueue row exists (id=${row.id})`)
  if (row.syncType === 'AD_BUDGET_UPDATE') pass(`syncType=AD_BUDGET_UPDATE`)
  else fail(`syncType expected AD_BUDGET_UPDATE, got ${row.syncType}`)
  if (row.syncStatus === 'PENDING') pass(`syncStatus=PENDING`)
  else fail(`syncStatus expected PENDING, got ${row.syncStatus}`)
  if (row.targetChannel === 'AMAZON') pass(`targetChannel=AMAZON`)
  else fail(`targetChannel expected AMAZON, got ${row.targetChannel}`)
  const holdMs = row.holdUntil ? row.holdUntil.getTime() - Date.now() : null
  if (holdMs != null && holdMs > 4 * 60 * 1000 && holdMs < 6 * 60 * 1000) {
    pass(`holdUntil ~ NOW + 5 min (${Math.round(holdMs / 1000)}s away)`)
  } else {
    fail(`holdUntil expected ~5 min from now, got ${holdMs}ms`)
  }
  const payload = typeof row.payload === 'string' ? JSON.parse(row.payload) : row.payload
  if (payload?.entityType === 'CAMPAIGN' && payload.entityId === camp.id) {
    pass(`payload.entityType + entityId correct`)
  } else {
    fail(`payload invalid: ${JSON.stringify(payload)}`)
  }
} else {
  fail(`expected exactly 1 OutboundSyncQueue row for id=${result.outboundQueueId}, got ${queueRow.rows.length}`)
}

// Assertion 3: CampaignBidHistory audit row.
const postH = await c.query(
  `SELECT COUNT(*) FROM "CampaignBidHistory" WHERE "campaignId" = $1`,
  [camp.id],
)
const histDelta = Number(postH.rows[0].count) - Number(pre.rows[0].h)
if (histDelta >= 1) {
  pass(`${histDelta} new CampaignBidHistory row(s) for this campaign`)
} else {
  fail(`expected ≥ 1 new CampaignBidHistory row, got ${histDelta}`)
}

const histRow = await c.query(
  `SELECT field, "oldValue", "newValue", "changedBy", reason FROM "CampaignBidHistory" WHERE "campaignId" = $1 ORDER BY "changedAt" DESC LIMIT 1`,
  [camp.id],
)
if (histRow.rows.length === 1) {
  const r = histRow.rows[0]
  if (r.field === 'dailyBudget' && r.changedBy === 'user:check-mutation-script') {
    pass(`history row field=dailyBudget changedBy=user:check-mutation-script`)
  } else {
    fail(`history row mismatch: field=${r.field} changedBy=${r.changedBy}`)
  }
}

await c.end()
process.exit(exitCode)
