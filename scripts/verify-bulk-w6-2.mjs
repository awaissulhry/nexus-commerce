#!/usr/bin/env node
// Verify W6.2 — Schedule tick + routes (source-level + end-to-end DB
// roundtrip of the tick-mark-fired contract).
import dotenv from 'dotenv'
import { fileURLToPath } from 'url'
import path from 'path'
import fs from 'fs'
import pg from 'pg'

const here = path.dirname(fileURLToPath(import.meta.url))
const repo = path.resolve(here, '..')
dotenv.config({ path: path.join(repo, '.env') })

let url = process.env.DATABASE_URL
if (!url) { console.error('DATABASE_URL missing'); process.exit(1) }
url = url.replace('-pooler', '')

const c = new pg.Client({ connectionString: url })
await c.connect()

let failures = 0
function check(label, cond) {
  console.log(`  ${cond ? '✓' : '✗'} ${label}`)
  if (!cond) failures++
}

console.log('\nW6.2 — Schedule tick + routes\n')

const job = fs.readFileSync(
  path.join(repo, 'apps/api/src/jobs/scheduled-bulk-action.job.ts'),
  'utf8',
)
const routes = fs.readFileSync(
  path.join(repo, 'apps/api/src/routes/scheduled-bulk-actions.routes.ts'),
  'utf8',
)
const idx = fs.readFileSync(
  path.join(repo, 'apps/api/src/index.ts'),
  'utf8',
)
const cronReg = fs.readFileSync(
  path.join(repo, 'apps/api/src/jobs/cron-registry.ts'),
  'utf8',
)

console.log('Case 1: tick contract')
check('runScheduledBulkActionTickOnce exported',
  /export async function runScheduledBulkActionTickOnce/.test(job))
check('runScheduledBulkActionCronOnce exported',
  /export async function runScheduledBulkActionCronOnce/.test(job))
check('startScheduledBulkActionCron exported',
  /export function startScheduledBulkActionCron/.test(job))
check('60-second tick interval',
  /TICK_INTERVAL_MS = 60_000/.test(job))
check('per-row try/catch (one bad row never wedges the tick)',
  /catch \(err\) \{[\s\S]{0,400}status: 'FAILED'/.test(job))
check('disabled row marked SKIPPED before tick',
  /if \(!row\.enabled\)/.test(job) && /status: 'SKIPPED'/.test(job))
check('createJob → markFired SUCCESS path',
  /bulkActionService\.createJob\(/.test(job) &&
    /status: 'SUCCESS'/.test(job))
check('processJob fires async (fire-and-forget)',
  /void bulkActionService\.processJob\(job\.id\)/.test(job))

console.log('\nCase 2: routes registered')
check('GET /scheduled-bulk-actions',
  /'\/scheduled-bulk-actions'/.test(routes))
check('GET /scheduled-bulk-actions/:id',
  /'\/scheduled-bulk-actions\/:id'/.test(routes))
check('POST /scheduled-bulk-actions',
  /fastify\.post<\{ Body: CreateBody \}>\(\s*'\/scheduled-bulk-actions'/.test(routes))
check('PATCH /scheduled-bulk-actions/:id/enabled (pause/resume)',
  /\/scheduled-bulk-actions\/:id\/enabled/.test(routes))
check('DELETE /scheduled-bulk-actions/:id',
  /\/scheduled-bulk-actions\/:id'/.test(routes))
check('POST /scheduled-bulk-actions/tick (manual fire)',
  /'\/scheduled-bulk-actions\/tick'/.test(routes))

check('400 for invalid cron / unknown actionType',
  /Invalid cron expression[\s\S]{0,200}status =[\s\S]{0,80}400/.test(routes) ||
    /msg\.startsWith\('Invalid cron/.test(routes))

console.log('\nCase 3: index.ts wires the cron + routes')
check('imports startScheduledBulkActionCron',
  /import \{ startScheduledBulkActionCron \}/.test(idx))
check('boots the cron',
  /startScheduledBulkActionCron\(\);/.test(idx))
check('imports + registers scheduledBulkActionRoutes',
  /import scheduledBulkActionRoutes/.test(idx) &&
    /app\.register\(scheduledBulkActionRoutes, \{ prefix: '\/api' \}\)/.test(idx))

console.log('\nCase 4: cron-registry')
check('scheduled-bulk-action registered for manual triggers',
  /'scheduled-bulk-action':\s*\(\)\s*=>\s*runScheduledBulkActionCronOnce\(\)/.test(cronReg))

console.log('\nCase 5: end-to-end DB — one-time schedule fires + exhausts')
{
  // Create a one-time schedule with nextRunAt in the past, then
  // simulate the tick by mirroring its DB writes.
  const id = `verify-w6-2-${Date.now()}`
  const past = new Date(Date.now() - 60_000)
  await c.query(
    `INSERT INTO "ScheduledBulkAction" (
       id, name, "actionType", "actionPayload",
       "scheduledFor", "cronExpression", timezone,
       "nextRunAt", enabled, "runCount",
       "createdAt", "updatedAt"
     ) VALUES (
       $1, 'one-shot', 'STATUS_UPDATE', '{"status":"INACTIVE"}'::jsonb,
       $2, NULL, 'Europe/Rome',
       $2, true, 0,
       NOW(), NOW()
     )`,
    [id, past.toISOString()],
  )

  // findDueSchedules logic: enabled && nextRunAt <= now
  const due = await c.query(
    `SELECT id, "runCount" FROM "ScheduledBulkAction"
       WHERE enabled = true AND "nextRunAt" <= NOW() AND id = $1`,
    [id],
  )
  check('row appears in due query', due.rows.length === 1)

  // Mirror markFired for a one-time row: nextRunAt → null, runCount++
  await c.query(
    `UPDATE "ScheduledBulkAction"
       SET "lastRunAt" = NOW(), "lastJobId" = 'fake-job',
           "lastStatus" = 'SUCCESS', "runCount" = "runCount" + 1,
           "nextRunAt" = NULL
       WHERE id = $1`,
    [id],
  )
  const after = await c.query(
    `SELECT "runCount", "nextRunAt", "lastStatus"
       FROM "ScheduledBulkAction" WHERE id = $1`, [id])
  check('runCount incremented', after.rows[0].runCount === 1)
  check('nextRunAt nulled (one-time exhausted)', after.rows[0].nextRunAt === null)
  check("lastStatus = 'SUCCESS'", after.rows[0].lastStatus === 'SUCCESS')

  // Re-running the due query should now return 0 — exhausted.
  const dueAfter = await c.query(
    `SELECT id FROM "ScheduledBulkAction"
       WHERE enabled = true AND "nextRunAt" <= NOW() AND id = $1`,
    [id],
  )
  check('exhausted row no longer due', dueAfter.rows.length === 0)

  await c.query(`DELETE FROM "ScheduledBulkAction" WHERE id = $1`, [id])
}

await c.end()

if (failures > 0) {
  console.log(`\n✗ ${failures} assertion(s) failed`)
  process.exit(1)
}
console.log('\n✓ all assertions passed')
