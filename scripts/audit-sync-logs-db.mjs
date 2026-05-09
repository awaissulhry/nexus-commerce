#!/usr/bin/env node
// Read-only audit queries for /sync-logs comprehensive audit.
// Run from repo root: node scripts/audit-sync-logs-db.mjs
import dotenv from 'dotenv'
import { fileURLToPath } from 'url'
import path from 'path'
import pg from 'pg'

const here = path.dirname(fileURLToPath(import.meta.url))
dotenv.config({ path: path.join(here, '..', '.env') })
dotenv.config({ path: path.join(here, '..', 'packages', 'database', '.env') })

const url = process.env.DATABASE_URL
if (!url) { console.error('DATABASE_URL missing'); process.exit(1) }

const client = new pg.Client({ connectionString: url })
await client.connect()

async function run(label, sql) {
  try {
    const r = await client.query(sql)
    console.log(`\n=== ${label} ===`)
    console.table(r.rows)
  } catch (e) {
    console.log(`\n=== ${label} (ERROR) ===`)
    console.log(e.message)
  }
}

await run('Observability tables present', `
  SELECT table_name FROM information_schema.tables
  WHERE table_schema='public'
  AND (table_name ILIKE '%log%' OR table_name ILIKE '%event%' OR table_name ILIKE '%audit%' OR table_name ILIKE '%queue%' OR table_name ILIKE '%job%')
  ORDER BY table_name;
`)

await run('SyncLog totals + breakdown', `
  SELECT count(*)::int AS total,
    count(*) FILTER (WHERE status = 'SUCCESS')::int AS success,
    count(*) FILTER (WHERE status = 'FAILED')::int AS failed,
    count(*) FILTER (WHERE status = 'IN_PROGRESS')::int AS in_progress,
    count(*) FILTER (WHERE status = 'PENDING')::int AS pending,
    count(DISTINCT "syncType")::int AS unique_types,
    MIN("createdAt") AS oldest,
    MAX("createdAt") AS most_recent
  FROM "SyncLog";
`)

await run('SyncLog by type x status', `
  SELECT "syncType", status, count(*)::int AS rows
  FROM "SyncLog"
  GROUP BY "syncType", status
  ORDER BY count(*) DESC LIMIT 30;
`)

await run('SyncLog last 7 days by day', `
  SELECT date_trunc('day', "startedAt")::date AS day,
         count(*)::int AS total,
         count(*) FILTER (WHERE status='FAILED')::int AS failed
  FROM "SyncLog"
  WHERE "startedAt" > NOW() - INTERVAL '30 days'
  GROUP BY day ORDER BY day DESC LIMIT 30;
`)

await run('SyncHealthLog totals', `
  SELECT count(*)::int AS total,
    count(*) FILTER (WHERE severity = 'INFO')::int AS info,
    count(*) FILTER (WHERE severity = 'WARNING')::int AS warning,
    count(*) FILTER (WHERE severity = 'ERROR')::int AS error,
    count(*) FILTER (WHERE severity = 'CRITICAL')::int AS critical,
    count(DISTINCT channel)::int AS unique_channels,
    MIN("createdAt") AS oldest,
    MAX("createdAt") AS most_recent
  FROM "SyncHealthLog";
`)

await run('SyncHealthLog by channel', `
  SELECT channel, "errorType", "resolutionStatus", count(*)::int AS rows
  FROM "SyncHealthLog"
  WHERE "createdAt" > NOW() - INTERVAL '30 days'
  GROUP BY channel, "errorType", "resolutionStatus"
  ORDER BY count(*) DESC LIMIT 30;
`)

await run('AuditLog totals + recent', `
  SELECT count(*)::int AS total,
    count(DISTINCT "entityType")::int AS unique_entities,
    count(DISTINCT action)::int AS unique_actions,
    count(DISTINCT "userId")::int AS unique_users,
    count(*) FILTER (WHERE "createdAt" > NOW() - INTERVAL '24 hours')::int AS last_24h,
    count(*) FILTER (WHERE "createdAt" > NOW() - INTERVAL '7 days')::int AS last_7d,
    count(*) FILTER (WHERE "createdAt" > NOW() - INTERVAL '30 days')::int AS last_30d,
    MIN("createdAt") AS oldest,
    MAX("createdAt") AS most_recent
  FROM "AuditLog";
`)

await run('AuditLog top entityType x action (7d)', `
  SELECT "entityType", action, count(*)::int AS rows
  FROM "AuditLog"
  WHERE "createdAt" > NOW() - INTERVAL '7 days'
  GROUP BY "entityType", action
  ORDER BY count(*) DESC LIMIT 30;
`)

await run('OutboundSyncQueue state', `
  SELECT count(*)::int AS total,
    count(*) FILTER (WHERE "syncStatus" = 'PENDING')::int AS pending,
    count(*) FILTER (WHERE "syncStatus" = 'IN_PROGRESS')::int AS in_progress,
    count(*) FILTER (WHERE "syncStatus" = 'SUCCESS')::int AS success,
    count(*) FILTER (WHERE "syncStatus" = 'FAILED')::int AS failed,
    count(*) FILTER (WHERE "syncStatus" = 'SKIPPED')::int AS skipped,
    count(*) FILTER (WHERE "syncStatus" = 'PENDING' AND "createdAt" < NOW() - INTERVAL '1 hour')::int AS stuck_pending
  FROM "OutboundSyncQueue";
`)

await run('OutboundSyncQueue by channel + status (7d)', `
  SELECT "targetChannel", "syncStatus", count(*)::int AS rows
  FROM "OutboundSyncQueue"
  WHERE "createdAt" > NOW() - INTERVAL '7 days'
  GROUP BY "targetChannel", "syncStatus"
  ORDER BY count(*) DESC LIMIT 30;
`)

await run('TrackingMessageLog state', `
  SELECT count(*)::int AS total,
    count(*) FILTER (WHERE status = 'PENDING')::int AS pending,
    count(*) FILTER (WHERE status = 'SUCCESS')::int AS success,
    count(*) FILTER (WHERE status = 'FAILED')::int AS failed,
    count(*) FILTER (WHERE status = 'DEAD_LETTER')::int AS dead_letter,
    AVG("attemptCount")::numeric(10,2) AS avg_attempts
  FROM "TrackingMessageLog";
`)

await run('BulkActionJob state', `
  SELECT count(*)::int AS total,
    count(*) FILTER (WHERE status = 'PENDING')::int AS pending,
    count(*) FILTER (WHERE status = 'IN_PROGRESS')::int AS in_progress,
    count(*) FILTER (WHERE status = 'COMPLETED')::int AS completed,
    count(*) FILTER (WHERE status = 'FAILED')::int AS failed,
    count(*) FILTER (WHERE status = 'CANCELLED')::int AS cancelled,
    count(*) FILTER (WHERE status = 'PARTIALLY_COMPLETED')::int AS partial
  FROM "BulkActionJob";
`)

await run('WebhookEvent state', `
  SELECT count(*)::int AS total,
    count(*) FILTER (WHERE "isProcessed" = true)::int AS processed,
    count(*) FILTER (WHERE "isProcessed" = false)::int AS unprocessed,
    count(*) FILTER (WHERE error IS NOT NULL)::int AS errored,
    count(DISTINCT channel)::int AS unique_channels,
    count(DISTINCT "eventType")::int AS unique_event_types
  FROM "WebhookEvent";
`)

await run('WebhookEvent by channel x type (7d)', `
  SELECT channel, "eventType", count(*)::int AS rows
  FROM "WebhookEvent"
  WHERE "createdAt" > NOW() - INTERVAL '7 days'
  GROUP BY channel, "eventType"
  ORDER BY count(*) DESC LIMIT 20;
`)

await run('SyncError table', `
  SELECT count(*)::int AS total,
    count(DISTINCT channel)::int AS unique_channels,
    count(DISTINCT "errorType")::int AS unique_errors
  FROM "SyncError";
`)

await run('RateLimitLog state', `
  SELECT count(*)::int AS total, count(DISTINCT channel)::int AS channels FROM "RateLimitLog";
`)

await run('AiUsageLog state', `
  SELECT count(*)::int AS total,
    count(DISTINCT provider)::int AS providers,
    count(DISTINCT feature)::int AS features,
    SUM("costUSD")::numeric(12,4) AS total_cost
  FROM "AiUsageLog"
  WHERE "createdAt" > NOW() - INTERVAL '30 days';
`)

await run('WizardStepEvent state', `
  SELECT count(*)::int AS total,
    count(*) FILTER (WHERE "createdAt" > NOW() - INTERVAL '7 days')::int AS last_7d
  FROM "WizardStepEvent";
`)

await run('StockMovement volume', `
  SELECT count(*)::int AS total,
    count(*) FILTER (WHERE "createdAt" > NOW() - INTERVAL '24 hours')::int AS last_24h,
    count(*) FILTER (WHERE "createdAt" > NOW() - INTERVAL '7 days')::int AS last_7d
  FROM "StockMovement";
`)

await run('Largest table sizes (heap+index, GB est.)', `
  SELECT relname AS table_name,
    pg_size_pretty(pg_total_relation_size(relid)) AS total_size,
    pg_total_relation_size(relid) AS bytes
  FROM pg_catalog.pg_statio_user_tables
  WHERE schemaname='public'
  ORDER BY pg_total_relation_size(relid) DESC
  LIMIT 25;
`)

await run('AuditLog hourly volume (last 7d)', `
  SELECT date_trunc('hour', "createdAt") AS hour,
         count(*)::int AS events
  FROM "AuditLog"
  WHERE "createdAt" > NOW() - INTERVAL '7 days'
  GROUP BY hour
  ORDER BY hour DESC LIMIT 30;
`)

await client.end()
console.log('\nDone.')

// Re-opening the connection just for this follow-up
import('pg').then(async (pgMod) => {
  const c = new pgMod.default.Client({ connectionString: process.env.DATABASE_URL })
  await c.connect()
  async function run2(label, sql) { try { const r = await c.query(sql); console.log(`\n=== ${label} ===`); console.table(r.rows) } catch (e) { console.log(`\n=== ${label} (ERROR) ===`); console.log(e.message) } }
  await run2('CronRun totals', `SELECT count(*)::int total, count(*) FILTER (WHERE status='SUCCESS')::int success, count(*) FILTER (WHERE status='FAILED')::int failed, count(*) FILTER (WHERE status='RUNNING')::int running, count(DISTINCT "jobName")::int unique_jobs, MIN("startedAt") oldest, MAX("startedAt") most_recent FROM "CronRun";`)
  await run2('CronRun by job (7d)', `SELECT "jobName", count(*)::int total, count(*) FILTER (WHERE status='SUCCESS')::int success, count(*) FILTER (WHERE status='FAILED')::int failed, MAX("startedAt") last_run FROM "CronRun" WHERE "startedAt" > NOW() - INTERVAL '7 days' GROUP BY "jobName" ORDER BY last_run DESC LIMIT 60;`)
  await run2('AutoPoRunLog state', `SELECT count(*)::int total, MAX("createdAt") most_recent FROM "AutoPoRunLog";`)
  await run2('StockLog state', `SELECT count(*)::int total, count(*) FILTER (WHERE "createdAt" > NOW() - INTERVAL '7 days')::int last_7d FROM "StockLog";`)
  await run2('TrackingEvent state', `SELECT count(*)::int total, count(*) FILTER (WHERE "createdAt" > NOW() - INTERVAL '7 days')::int last_7d FROM "TrackingEvent";`)
  await run2('RetailEvent state', `SELECT count(*)::int total FROM "RetailEvent";`)
  await c.end()
})
