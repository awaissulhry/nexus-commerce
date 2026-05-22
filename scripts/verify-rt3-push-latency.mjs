#!/usr/bin/env node
/**
 * RT.3 verifier — computes push latency percentiles directly against
 * the DB, mirroring the /api/admin/push-latency endpoint.
 *
 * Reports:
 *   1. Schema check — does WebhookEvent.providerTimestamp exist?
 *   2. Per-source row counts with/without providerTimestamp (last 24h)
 *   3. p50/p95/p99 latency per source (last 24h)
 *
 * Useful pre-deploy to confirm the migration ran and post-deploy to
 * sanity-check the endpoint returns the same numbers the SQL says.
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

console.log('\n=== 1. Schema check ===')
const colCheck = await c.query(`
  SELECT column_name, data_type, is_nullable
  FROM information_schema.columns
  WHERE table_name = 'WebhookEvent' AND column_name = 'providerTimestamp';
`)
if (colCheck.rows.length === 0) {
  console.log('providerTimestamp column NOT present — migration not yet applied.')
  await c.end()
  process.exit(1)
}
console.table(colCheck.rows)

console.log('\n=== 2. Per-source row counts (last 24h) ===')
const counts = await c.query(`
  SELECT
    channel,
    count(*) AS total,
    count(*) FILTER (WHERE "providerTimestamp" IS NOT NULL) AS with_ts,
    count(*) FILTER (WHERE "providerTimestamp" IS NULL)     AS without_ts
  FROM "WebhookEvent"
  WHERE "createdAt" > now() - interval '24 hours'
    AND channel IN ('AMAZON', 'EBAY', 'SHOPIFY')
  GROUP BY channel
  ORDER BY channel;
`)
console.table(counts.rows)

console.log('\n=== 3. Per-source p50/p95/p99 latency (last 24h, ms) ===')
const perc = await c.query(`
  SELECT
    channel,
    count(*) AS samples,
    round(percentile_cont(0.50) WITHIN GROUP (
      ORDER BY EXTRACT(EPOCH FROM ("createdAt" - "providerTimestamp")) * 1000
    )) AS p50_ms,
    round(percentile_cont(0.95) WITHIN GROUP (
      ORDER BY EXTRACT(EPOCH FROM ("createdAt" - "providerTimestamp")) * 1000
    )) AS p95_ms,
    round(percentile_cont(0.99) WITHIN GROUP (
      ORDER BY EXTRACT(EPOCH FROM ("createdAt" - "providerTimestamp")) * 1000
    )) AS p99_ms,
    round(min(EXTRACT(EPOCH FROM ("createdAt" - "providerTimestamp")) * 1000)) AS min_ms,
    round(max(EXTRACT(EPOCH FROM ("createdAt" - "providerTimestamp")) * 1000)) AS max_ms
  FROM "WebhookEvent"
  WHERE "createdAt" > now() - interval '24 hours'
    AND "providerTimestamp" IS NOT NULL
    AND channel IN ('AMAZON', 'EBAY', 'SHOPIFY')
  GROUP BY channel
  ORDER BY channel;
`)
if (perc.rows.length === 0) {
  console.log('No rows with providerTimestamp yet — wait for next push notifications.')
} else {
  console.table(perc.rows)
}

await c.end()
console.log('\nTip: hit GET /api/admin/push-latency?window=24h to compare against this.')
