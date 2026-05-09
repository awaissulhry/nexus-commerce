#!/usr/bin/env node
// Comprehensive enterprise /bulk-operations audit (read-only).
import dotenv from 'dotenv'
import { fileURLToPath } from 'url'
import path from 'path'
import pg from 'pg'

const here = path.dirname(fileURLToPath(import.meta.url))
dotenv.config({ path: path.join(here, '..', '.env') })

let url = process.env.DATABASE_URL
if (!url) { console.error('DATABASE_URL missing'); process.exit(1) }
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

await run('1. BulkActionJob volume + status mix', `
  SELECT count(*) AS total_jobs,
    count(*) FILTER (WHERE status = 'PENDING') AS pending,
    count(*) FILTER (WHERE status = 'QUEUED') AS queued,
    count(*) FILTER (WHERE status = 'IN_PROGRESS') AS in_progress,
    count(*) FILTER (WHERE status = 'COMPLETED') AS completed,
    count(*) FILTER (WHERE status = 'FAILED') AS failed,
    count(*) FILTER (WHERE status = 'CANCELLED') AS cancelled,
    count(*) FILTER (WHERE status = 'PARTIALLY_COMPLETED') AS partial,
    MIN("createdAt") AS oldest_job,
    MAX("createdAt") AS newest_job
  FROM "BulkActionJob"`)

await run('2. Jobs by actionType (last 30d)', `
  SELECT "actionType", count(*) AS jobs,
    AVG("totalItems")::int AS avg_items,
    SUM("processedItems") AS total_processed,
    SUM("failedItems") AS total_failed
  FROM "BulkActionJob"
  WHERE "createdAt" > NOW() - INTERVAL '30 days'
  GROUP BY "actionType"
  ORDER BY count(*) DESC`)

await run('3. Daily job pattern (last 30d)', `
  SELECT date_trunc('day', "createdAt")::date AS day,
    count(*) AS jobs,
    count(*) FILTER (WHERE status = 'FAILED') AS failures,
    count(*) FILTER (WHERE status = 'PARTIALLY_COMPLETED') AS partial,
    AVG(EXTRACT(EPOCH FROM ("completedAt" - "createdAt")))::int AS avg_seconds
  FROM "BulkActionJob"
  WHERE "createdAt" > NOW() - INTERVAL '30 days'
  GROUP BY day
  ORDER BY day DESC
  LIMIT 14`)

await run('4. Jobs by channel', `
  SELECT COALESCE(channel,'(all)') AS channel, count(*) AS jobs,
    count(*) FILTER (WHERE status = 'FAILED') AS failed
  FROM "BulkActionJob"
  WHERE "createdAt" > NOW() - INTERVAL '30 days'
  GROUP BY channel
  ORDER BY count(*) DESC`)

await run('5. BulkActionItem (per-row results)', `
  SELECT count(*) AS total_items,
    count(*) FILTER (WHERE status = 'SUCCEEDED') AS success,
    count(*) FILTER (WHERE status = 'FAILED') AS failed,
    count(*) FILTER (WHERE status = 'SKIPPED') AS skipped,
    count(*) FILTER (WHERE status = 'PENDING') AS pending,
    count(DISTINCT "jobId") AS jobs_with_items
  FROM "BulkActionItem"`)

await run('6. Job size distribution', `
  SELECT
    AVG("totalItems")::int AS avg_items,
    MAX("totalItems") AS max_items,
    count(*) FILTER (WHERE "totalItems" > 100) AS jobs_over_100,
    count(*) FILTER (WHERE "totalItems" > 1000) AS jobs_over_1000,
    count(*) FILTER (WHERE "totalItems" > 5000) AS jobs_over_5000,
    count(*) FILTER (WHERE "totalItems" > 10000) AS jobs_over_10000
  FROM "BulkActionJob"`)

await run('7. Rollback usage', `
  SELECT
    count(*) FILTER (WHERE "rollbackJobId" IS NOT NULL) AS jobs_rolled_back,
    count(*) FILTER (WHERE "isRollbackable" = true) AS jobs_marked_rollbackable,
    count(*) FILTER (WHERE "rollbackData" IS NOT NULL) AS jobs_with_rollback_data,
    count(*) AS total
  FROM "BulkActionJob"`)

await run('8. BulkOpsTemplate (saved views)', `
  SELECT count(*) AS templates,
    count(DISTINCT "userId") AS distinct_users,
    MIN("createdAt") AS oldest,
    MAX("updatedAt") AS most_recent_update
  FROM "BulkOpsTemplate"`)

await run('9. BulkOpsTemplate detail', `
  SELECT id, name, "userId", array_length("columnIds",1) AS columns,
    array_length("enabledChannels",1) AS channels,
    array_length("enabledProductTypes",1) AS product_types,
    "updatedAt"
  FROM "BulkOpsTemplate"
  ORDER BY "updatedAt" DESC
  LIMIT 20`)

await run('10. Legacy BulkOperation (CSV upload)', `
  SELECT count(*) AS total,
    count(*) FILTER (WHERE status = 'SUCCESS') AS success,
    count(*) FILTER (WHERE status = 'FAILED') AS failed,
    count(*) FILTER (WHERE status = 'PARTIAL') AS partial,
    count(*) FILTER (WHERE status = 'PENDING_APPLY') AS pending_apply,
    count(*) FILTER (WHERE "expiresAt" IS NOT NULL AND "expiresAt" < NOW()) AS expired,
    MAX("createdAt") AS most_recent
  FROM "BulkOperation"`)

await run('11. AutomationRule by domain', `
  SELECT domain, count(*) AS rules,
    count(*) FILTER (WHERE enabled) AS enabled,
    count(*) FILTER (WHERE "dryRun") AS dry_run,
    SUM("evaluationCount") AS total_evaluations,
    SUM("executionCount") AS total_executions
  FROM "AutomationRule"
  GROUP BY domain`)

await run('12. ScheduledProductChange', `
  SELECT count(*) AS total,
    count(*) FILTER (WHERE status = 'PENDING') AS pending,
    count(*) FILTER (WHERE status = 'APPLIED') AS applied,
    count(*) FILTER (WHERE status = 'FAILED') AS failed,
    count(*) FILTER (WHERE "scheduledFor" > NOW()) AS in_future
  FROM "ScheduledProductChange"`)

await run('13. Top job creators', `
  SELECT COALESCE("createdBy",'(null)') AS user,
    count(*) AS jobs,
    SUM("totalItems") AS total_items
  FROM "BulkActionJob"
  WHERE "createdAt" > NOW() - INTERVAL '30 days'
  GROUP BY "createdBy"
  ORDER BY count(*) DESC
  LIMIT 10`)

await run('14. Most recent 10 jobs', `
  SELECT id, "jobName", "actionType", channel, status,
    "totalItems", "processedItems", "failedItems", "progressPercent",
    "createdAt"
  FROM "BulkActionJob"
  ORDER BY "createdAt" DESC
  LIMIT 10`)

await run('15. BulkActionJob columns (schema introspection)', `
  SELECT column_name, data_type, is_nullable
  FROM information_schema.columns
  WHERE table_name = 'BulkActionJob'
  ORDER BY ordinal_position`)

await run('16. All bulk/import/export/automation tables', `
  SELECT table_name FROM information_schema.tables
  WHERE table_schema = 'public'
    AND (table_name ILIKE '%bulk%'
      OR table_name ILIKE '%import%'
      OR table_name ILIKE '%export%'
      OR table_name ILIKE '%schedul%'
      OR table_name ILIKE '%template%'
      OR table_name ILIKE '%automation%')
  ORDER BY table_name`)

await run('17. Stale PENDING_APPLY uploads', `
  SELECT id, "uploadFilename", "productCount", "changeCount", status,
    "createdAt", "expiresAt",
    EXTRACT(EPOCH FROM (NOW() - "createdAt"))/3600 AS hours_old
  FROM "BulkOperation"
  WHERE status = 'PENDING_APPLY'
  ORDER BY "createdAt" DESC
  LIMIT 20`)

await run('18. Active jobs RIGHT NOW', `
  SELECT id, "jobName", "actionType", status,
    "processedItems" || '/' || "totalItems" AS progress,
    "progressPercent" AS pct,
    "createdAt", "startedAt"
  FROM "BulkActionJob"
  WHERE status IN ('PENDING','QUEUED','IN_PROGRESS')
  ORDER BY "createdAt" DESC
  LIMIT 20`)

await run('19. Failed items detail (recent)', `
  SELECT bai."jobId", baj."jobName", baj."actionType",
    bai.status, bai."errorMessage",
    bai."createdAt"
  FROM "BulkActionItem" bai
  JOIN "BulkActionJob" baj ON baj.id = bai."jobId"
  WHERE bai.status = 'FAILED'
  ORDER BY bai."createdAt" DESC
  LIMIT 10`)

await run('20. Rollback chain (jobs that rolled back another)', `
  SELECT child.id AS rollback_job_id, child."jobName" AS rollback_name,
    parent.id AS original_id, parent."jobName" AS original_name,
    child."createdAt" AS rolled_back_at
  FROM "BulkActionJob" child
  JOIN "BulkActionJob" parent ON parent."rollbackJobId" = child.id
  ORDER BY child."createdAt" DESC
  LIMIT 10`)

await c.end()
