#!/usr/bin/env node
/**
 * RT.1 verifier — proves /api/admin/push-health returns the expected
 * unified shape across Amazon + eBay + Shopify, and that recent
 * WebhookEvent rows for each source actually populate the response.
 *
 * Read-only. Reports:
 *   1. WebhookEvent row counts per channel (last 24h)
 *   2. Inferred status per source (live / quiet / silent / never)
 *   3. SQS env wiring (queue URL + region resolution)
 *
 * Doesn't call the HTTP endpoint — that requires auth + Railway. The
 * DB query mirrors the endpoint's SQL so we know what the endpoint
 * would return.
 */

import dotenv from 'dotenv'
import { fileURLToPath } from 'url'
import path from 'path'
import pg from 'pg'

const here = path.dirname(fileURLToPath(import.meta.url))
dotenv.config({ path: path.join(here, '..', '.env') })

const url = process.env.DATABASE_URL
if (!url) { console.error('DATABASE_URL missing'); process.exit(1) }
const c = new pg.Client({ connectionString: url })
await c.connect()

function statusFromAgeSec(sec) {
  if (sec === null) return 'never'
  if (sec < 5 * 60) return 'live'
  if (sec < 60 * 60) return 'quiet'
  return 'silent'
}

async function q(label, sql) {
  const r = await c.query(sql)
  console.log(`\n=== ${label} ===`)
  if (r.rows.length === 0) console.log('(no rows)')
  else console.table(r.rows)
  return r.rows
}

const perSourceRows = await q(
  '1. WebhookEvent counts per channel (last 24h)',
  `
  SELECT
    channel,
    count(*) AS rows_24h,
    count(*) FILTER (WHERE "isProcessed") AS processed,
    count(*) FILTER (WHERE "error" IS NOT NULL) AS failed,
    max("createdAt") AS most_recent
  FROM "WebhookEvent"
  WHERE "createdAt" > now() - interval '24 hours'
    AND channel IN ('AMAZON', 'EBAY', 'SHOPIFY')
  GROUP BY channel
  ORDER BY channel;
`,
)

console.log('\n=== 2. Inferred per-source status ===')
const seen = new Map(perSourceRows.map((r) => [r.channel, r]))
const rows = ['AMAZON', 'EBAY', 'SHOPIFY'].map((src) => {
  const row = seen.get(src)
  if (!row) return { source: src, status: 'never', ageSec: null, rows24h: 0 }
  const ageSec = Math.floor((Date.now() - new Date(row.most_recent).getTime()) / 1000)
  return {
    source: src,
    status: statusFromAgeSec(ageSec),
    ageSec,
    rows24h: Number(row.rows_24h),
  }
})
console.table(rows)

console.log('\n=== 3. SQS env wiring ===')
const queueUrl = process.env.AMAZON_SQS_QUEUE_URL ?? '(unset)'
const accessKey = process.env.AWS_ACCESS_KEY_ID ? '(set)' : '(unset)'
const region =
  process.env.AWS_REGION ??
  process.env.AMAZON_SQS_QUEUE_URL?.match(/sqs\.([^.]+)\.amazonaws\.com/)?.[1] ??
  '(unresolved)'
console.log({ queueUrl: queueUrl.replace(/\/\d{10,}/g, '/<accountId>'), accessKey, region })

await c.end()
console.log(
  '\nTip: hit GET /api/admin/push-health in a logged-in tab to compare against this snapshot.',
)
