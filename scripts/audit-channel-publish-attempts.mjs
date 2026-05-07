#!/usr/bin/env node
// V.1 — Phase B verification harness for the syndication channel-write
// rollout. Reads ChannelPublishAttempt directly from Neon and prints
// a multi-section report:
//
//   1. Counts by (channel, mode, outcome) over the last 24h, 7d, 30d
//   2. Recent failures with reason text (operator triages from this)
//   3. Per-channel circuit health — back-to-back failures within the
//      breaker window
//   4. Distinct SKUs that have hit the gate (gives a sense of how many
//      different listings the operator has actually pushed against)
//
// Run: `node scripts/audit-channel-publish-attempts.mjs`
//
// Read-only — no writes, no migrations, no flag flips. Safe to run
// against production whenever the operator wants a snapshot.

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

const c = new pg.Client({ connectionString: url })
await c.connect()

async function run(label, sql, params = []) {
  try {
    const r = await c.query(sql, params)
    console.log(`\n=== ${label} ===`)
    if (r.rows.length === 0) {
      console.log('(no rows)')
    } else {
      console.table(r.rows)
    }
    return r.rows
  } catch (e) {
    console.log(`\n=== ${label} (ERROR) ===`)
    console.log(e.message)
    return []
  }
}

// ── 1. Roll-up by channel × mode × outcome over multiple windows ────
await run(
  '1. Activity by (channel, mode, outcome) — last 24h',
  `SELECT channel,
          mode,
          outcome,
          count(*)::int AS attempts,
          count(DISTINCT sku)::int AS distinct_skus
   FROM "ChannelPublishAttempt"
   WHERE "attemptedAt" > NOW() - INTERVAL '24 hours'
   GROUP BY channel, mode, outcome
   ORDER BY channel, mode, attempts DESC`,
)

await run(
  '2. Activity by (channel, mode, outcome) — last 7 days',
  `SELECT channel,
          mode,
          outcome,
          count(*)::int AS attempts,
          count(DISTINCT sku)::int AS distinct_skus
   FROM "ChannelPublishAttempt"
   WHERE "attemptedAt" > NOW() - INTERVAL '7 days'
   GROUP BY channel, mode, outcome
   ORDER BY channel, mode, attempts DESC`,
)

await run(
  '3. Total attempts — last 30 days (top-level health)',
  `SELECT channel,
          count(*)::int AS attempts,
          count(*) FILTER (WHERE outcome = 'success')::int AS succeeded,
          count(*) FILTER (WHERE outcome = 'gated')::int AS gated,
          count(*) FILTER (WHERE outcome = 'failed')::int AS failed,
          count(*) FILTER (WHERE outcome = 'rate-limited')::int AS rate_limited,
          count(*) FILTER (WHERE outcome = 'circuit-open')::int AS circuit_open,
          count(*) FILTER (WHERE outcome = 'timeout')::int AS timed_out,
          ROUND(100.0 * count(*) FILTER (WHERE outcome = 'success') /
                NULLIF(count(*), 0)::numeric, 1) AS success_pct
   FROM "ChannelPublishAttempt"
   WHERE "attemptedAt" > NOW() - INTERVAL '30 days'
   GROUP BY channel
   ORDER BY channel`,
)

// ── 2. Recent failures (top 20) — operator triages from this ────────
await run(
  '4. Recent failures — top 20 in the last 7 days',
  `SELECT "attemptedAt"::timestamp(0) AS at,
          channel,
          marketplace,
          mode,
          outcome,
          sku,
          LEFT("errorMessage", 100) AS error_excerpt
   FROM "ChannelPublishAttempt"
   WHERE "attemptedAt" > NOW() - INTERVAL '7 days'
     AND outcome != 'success'
     AND outcome != 'gated'
   ORDER BY "attemptedAt" DESC
   LIMIT 20`,
)

// ── 3. Per-channel circuit health — back-to-back failures ───────────
// The breaker opens at 3 consecutive failures within 5 min.
// This query surfaces (channel, marketplace, sellerId) tuples with 3+
// failures in the last 5 min so the operator knows which circuits
// are likely tripped right now.
await run(
  '5. Likely-tripped circuits — 3+ failures in last 5 min',
  `SELECT channel,
          marketplace,
          "sellerId",
          count(*)::int AS recent_failures,
          MAX("attemptedAt")::timestamp(0) AS last_failure
   FROM "ChannelPublishAttempt"
   WHERE "attemptedAt" > NOW() - INTERVAL '5 minutes'
     AND outcome IN ('failed', 'timeout')
   GROUP BY channel, marketplace, "sellerId"
   HAVING count(*) >= 3
   ORDER BY recent_failures DESC, last_failure DESC`,
)

// ── 4. Distinct SKUs touched per (channel, mode) ────────────────────
await run(
  '6. SKU coverage by (channel, mode) — last 30 days',
  `SELECT channel,
          mode,
          count(DISTINCT sku)::int AS distinct_skus,
          MIN("attemptedAt")::timestamp(0) AS first_seen,
          MAX("attemptedAt")::timestamp(0) AS last_seen
   FROM "ChannelPublishAttempt"
   WHERE "attemptedAt" > NOW() - INTERVAL '30 days'
   GROUP BY channel, mode
   ORDER BY channel, mode`,
)

// ── 5. Repeat-attempts on same SKU (potential drift / loop) ────────
await run(
  '7. SKUs with most attempts — last 7 days (top 10)',
  `SELECT sku,
          channel,
          marketplace,
          count(*)::int AS attempts,
          count(*) FILTER (WHERE outcome = 'success')::int AS succeeded,
          count(*) FILTER (WHERE outcome != 'success' AND outcome != 'gated')::int AS unhappy
   FROM "ChannelPublishAttempt"
   WHERE "attemptedAt" > NOW() - INTERVAL '7 days'
   GROUP BY sku, channel, marketplace
   HAVING count(*) > 1
   ORDER BY attempts DESC
   LIMIT 10`,
)

// ── 6. Current env mode (read schema for hints — operator-facing) ───
console.log('\n=== 8. Reminder — current Railway env (operator must check) ===')
console.log(
  '  NEXUS_ENABLE_AMAZON_PUBLISH  — must be `true` for any AMAZON outcome != gated',
)
console.log(
  '  AMAZON_PUBLISH_MODE          — `dry-run` (no HTTP), `sandbox`, `live`',
)
console.log(
  '  NEXUS_ENABLE_EBAY_PUBLISH    — same shape for EBAY',
)
console.log(
  '  EBAY_PUBLISH_MODE            — `dry-run`, `sandbox`, `live`',
)
console.log(
  '  Defaults are gated + dry-run; flip explicitly when you want HTTP.',
)

await c.end()
console.log('\nDone.')
