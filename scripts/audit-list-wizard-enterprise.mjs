#!/usr/bin/env node
// Comprehensive enterprise /products/[id]/list-wizard audit (read-only).
//
// Surfaces:
//   - ListingWizard funnel (DRAFT/SUBMITTED/LIVE/FAILED, stale, currentStep)
//   - Per-step distribution + per-channel target distribution
//   - WizardStepEvent telemetry depth (type counts, top errorCodes, durations)
//   - Submission velocity + ChannelListing created from wizard
//   - AI cost per wizard via AiUsageLog feature='listing-wizard'
//   - Cleanup-job posture (orphans, expired-but-not-yet-swept)
//
// Read-only — never mutates. Safe to run on prod (mirrors the existing
// scripts/audit-products-enterprise.mjs pattern).
import dotenv from 'dotenv'
import { fileURLToPath } from 'url'
import path from 'path'
import pg from 'pg'

const here = path.dirname(fileURLToPath(import.meta.url))
dotenv.config({ path: path.join(here, '..', '.env') })

let url = process.env.DATABASE_URL
if (!url) {
  console.error('DATABASE_URL missing')
  process.exit(1)
}
// Strip pooler suffix — analytics queries hit large tables and pgbouncer
// transaction-mode chokes on session-scoped temp state.
url = url.replace('-pooler', '')

const c = new pg.Client({ connectionString: url })
await c.connect()

async function run(label, sql) {
  try {
    const r = await c.query(sql)
    console.log(`\n=== ${label} ===`)
    if (r.rows.length === 0) console.log('(no rows)')
    else console.table(r.rows)
  } catch (e) {
    console.log(`\n=== ${label} (ERROR) ===\n${e.message}`)
  }
}

await run('1. ListingWizard funnel', `
  SELECT count(*) AS total,
         count(*) FILTER (WHERE status = 'DRAFT') AS draft,
         count(*) FILTER (WHERE status = 'SUBMITTED') AS submitted,
         count(*) FILTER (WHERE status = 'LIVE') AS live,
         count(*) FILTER (WHERE status = 'FAILED') AS failed,
         count(*) FILTER (WHERE "expiresAt" < NOW() AND status = 'DRAFT') AS stale_drafts,
         count(*) FILTER (WHERE "expiresAt" IS NULL AND status = 'DRAFT') AS draft_no_expiry,
         AVG("currentStep")::numeric(5,2) AS avg_step,
         MAX("currentStep") AS max_step,
         MIN("createdAt")::date AS oldest,
         MAX("updatedAt")::date AS latest_activity
  FROM "ListingWizard"
`)

await run('2. Funnel by currentStep', `
  SELECT "currentStep" AS step,
         count(*) AS wizards,
         count(*) FILTER (WHERE status = 'DRAFT') AS still_draft,
         count(*) FILTER (WHERE status = 'SUBMITTED') AS submitted,
         count(*) FILTER (WHERE status = 'LIVE') AS live,
         count(*) FILTER (WHERE status = 'FAILED') AS failed
  FROM "ListingWizard"
  GROUP BY "currentStep"
  ORDER BY "currentStep"
`)

await run('3. Per-platform target distribution (drafts + submitted)', `
  WITH expanded AS (
    SELECT lw.id,
           lw.status,
           jsonb_array_elements(lw.channels) AS ch
    FROM "ListingWizard" lw
  )
  SELECT ch->>'platform' AS platform,
         ch->>'marketplace' AS marketplace,
         count(*) AS wizards,
         count(*) FILTER (WHERE status = 'SUBMITTED' OR status = 'LIVE') AS reached_submit
  FROM expanded
  GROUP BY platform, marketplace
  ORDER BY wizards DESC
  LIMIT 30
`)

await run('4. Wizard age distribution (drafts only)', `
  SELECT count(*) FILTER (WHERE NOW() - "createdAt" < INTERVAL '1 hour') AS lt_1h,
         count(*) FILTER (WHERE NOW() - "createdAt" BETWEEN INTERVAL '1 hour' AND INTERVAL '1 day') AS lt_1d,
         count(*) FILTER (WHERE NOW() - "createdAt" BETWEEN INTERVAL '1 day' AND INTERVAL '7 days') AS lt_7d,
         count(*) FILTER (WHERE NOW() - "createdAt" BETWEEN INTERVAL '7 days' AND INTERVAL '30 days') AS lt_30d,
         count(*) FILTER (WHERE NOW() - "createdAt" >= INTERVAL '30 days') AS gte_30d
  FROM "ListingWizard"
  WHERE status = 'DRAFT'
`)

await run('5. Session length (drafts — gap between create + last update)', `
  SELECT count(*) AS draft_count,
         AVG(EXTRACT(EPOCH FROM ("updatedAt" - "createdAt")))::int AS avg_session_seconds,
         count(*) FILTER (WHERE "updatedAt" - "createdAt" < INTERVAL '5 minutes') AS quick_abandon_lt_5m,
         count(*) FILTER (WHERE "updatedAt" - "createdAt" BETWEEN INTERVAL '5 minutes' AND INTERVAL '1 hour') AS engaged_5m_1h,
         count(*) FILTER (WHERE "updatedAt" - "createdAt" >= INTERVAL '1 hour') AS long_session_gte_1h
  FROM "ListingWizard"
  WHERE status = 'DRAFT'
`)

await run('6. WizardStepEvent type distribution (last 90d)', `
  SELECT type, count(*) AS events
  FROM "WizardStepEvent"
  WHERE "createdAt" > NOW() - INTERVAL '90 days'
  GROUP BY type
  ORDER BY events DESC
`)

await run('7. Per-step time spent (step_exited durations, last 90d)', `
  SELECT step,
         count(*) AS events,
         AVG("durationMs")::int AS avg_ms,
         MIN("durationMs")::int AS min_ms,
         (PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY "durationMs"))::int AS p50_ms,
         (PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY "durationMs"))::int AS p95_ms,
         MAX("durationMs")::int AS max_ms
  FROM "WizardStepEvent"
  WHERE type = 'step_exited'
    AND "durationMs" IS NOT NULL
    AND "createdAt" > NOW() - INTERVAL '90 days'
  GROUP BY step
  ORDER BY step
`)

await run('8. Top errorCodes by step (last 90d)', `
  SELECT step, "errorCode", count(*) AS occurrences
  FROM "WizardStepEvent"
  WHERE "errorCode" IS NOT NULL
    AND "createdAt" > NOW() - INTERVAL '90 days'
  GROUP BY step, "errorCode"
  ORDER BY occurrences DESC
  LIMIT 20
`)

await run('9. Drop-off causes — validation_failed by step (last 90d)', `
  SELECT step,
         count(*) AS validation_failures,
         count(DISTINCT "wizardId") AS distinct_wizards
  FROM "WizardStepEvent"
  WHERE type = 'validation_failed'
    AND "createdAt" > NOW() - INTERVAL '90 days'
  GROUP BY step
  ORDER BY step
`)

await run('10. Submit attempts (success vs fail, last 90d)', `
  SELECT type,
         count(*) AS attempts,
         AVG("durationMs")::int AS avg_total_duration_ms
  FROM "WizardStepEvent"
  WHERE type IN ('submit_completed', 'submit_failed')
    AND "createdAt" > NOW() - INTERVAL '90 days'
  GROUP BY type
`)

await run('11. Wizard.created vs wizard.submitted velocity (last 30d)', `
  SELECT date_trunc('day', "createdAt")::date AS day,
         count(*) FILTER (WHERE type = 'wizard_started') AS started,
         count(*) FILTER (WHERE type = 'submit_completed') AS submitted_ok,
         count(*) FILTER (WHERE type = 'submit_failed') AS submitted_fail,
         count(*) FILTER (WHERE type = 'wizard_discarded') AS discarded
  FROM "WizardStepEvent"
  WHERE "createdAt" > NOW() - INTERVAL '30 days'
  GROUP BY day
  ORDER BY day DESC
`)

await run('12. ChannelListing created via wizard (last 30d)', `
  SELECT cl.channel,
         cl.marketplace,
         count(*) AS listings
  FROM "ChannelListing" cl
  WHERE cl."createdAt" > NOW() - INTERVAL '30 days'
  GROUP BY cl.channel, cl.marketplace
  ORDER BY listings DESC
`)

await run('13. AI cost — feature=listing-wizard (last 30d, by provider)', `
  SELECT provider, model,
         count(*) AS calls,
         SUM("inputTokens") AS in_tokens,
         SUM("outputTokens") AS out_tokens,
         SUM("costUSD")::numeric(12,4) AS cost_usd,
         AVG("latencyMs")::int AS avg_latency_ms,
         count(*) FILTER (WHERE ok = false) AS failures
  FROM "AiUsageLog"
  WHERE feature = 'listing-wizard'
    AND "createdAt" > NOW() - INTERVAL '30 days'
  GROUP BY provider, model
  ORDER BY cost_usd DESC
`)

await run('14. AI cost per wizard (top 20, last 30d)', `
  SELECT "entityId" AS wizard_id,
         count(*) AS calls,
         SUM("costUSD")::numeric(12,4) AS cost_usd,
         array_agg(DISTINCT provider) AS providers,
         array_agg(DISTINCT model) AS models
  FROM "AiUsageLog"
  WHERE feature = 'listing-wizard'
    AND "entityType" = 'ListingWizard'
    AND "createdAt" > NOW() - INTERVAL '30 days'
  GROUP BY "entityId"
  ORDER BY cost_usd DESC
  LIMIT 20
`)

await run('15. Cleanup posture — orphans + stale-but-not-deleted', `
  SELECT count(*) FILTER (WHERE status = 'DRAFT' AND "expiresAt" < NOW()) AS expired_still_draft,
         count(*) FILTER (WHERE status = 'DRAFT' AND "expiresAt" IS NULL) AS no_expiry,
         count(*) FILTER (WHERE status NOT IN ('DRAFT','SUBMITTED','LIVE','FAILED','EXPIRED','DISCARDED')) AS unknown_status,
         count(*) FILTER (WHERE "completedAt" IS NULL AND status IN ('SUBMITTED','LIVE')) AS terminal_no_completedAt
  FROM "ListingWizard"
`)

await run('16. Wizard.created event guard — duplicate emits per wizard', `
  SELECT count(*) AS wizards_with_dup_started,
         max(c) AS worst_count
  FROM (
    SELECT "wizardId", count(*) AS c
    FROM "WizardStepEvent"
    WHERE type = 'wizard_started'
    GROUP BY "wizardId"
    HAVING count(*) > 1
  ) s
`)

await run('17. Conflict detection — optimistic-concurrency 409 frequency', `
  SELECT count(*) AS conflict_events,
         count(DISTINCT "wizardId") AS wizards_with_conflicts
  FROM "WizardStepEvent"
  WHERE "errorCode" = 'conflict_409'
    AND "createdAt" > NOW() - INTERVAL '90 days'
`)

await run('18. Provider-mode posture (Amazon publish gate)', `
  SELECT count(*) AS amazon_publish_audit_rows,
         count(*) FILTER (WHERE outcome = 'gated') AS gated,
         count(*) FILTER (WHERE outcome = 'rate-limited') AS rate_limited,
         count(*) FILTER (WHERE outcome = 'circuit-open') AS circuit_open,
         count(*) FILTER (WHERE outcome = 'success') AS success,
         count(*) FILTER (WHERE outcome NOT IN ('gated','rate-limited','circuit-open','success')) AS other
  FROM "ChannelPublishAuditLog"
  WHERE channel = 'AMAZON'
    AND "createdAt" > NOW() - INTERVAL '30 days'
`)

await c.end()
console.log('\n— audit complete —')
