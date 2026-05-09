#!/usr/bin/env node
// Verify W8.4 — scheduled-imports service + worker + routes.
// Closes Wave 8.
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

console.log('\nW8.4 — scheduled imports\n')

const svc = fs.readFileSync(
  path.join(repo, 'apps/api/src/services/scheduled-import.service.ts'),
  'utf8',
)
const job = fs.readFileSync(
  path.join(repo, 'apps/api/src/jobs/scheduled-import.job.ts'),
  'utf8',
)
const routes = fs.readFileSync(
  path.join(repo, 'apps/api/src/routes/scheduled-imports.routes.ts'),
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

console.log('Case 1: service shape')
for (const sym of ['class ScheduledImportService','create(','list(','get(','setEnabled(','delete(','findDue(','fireOnce(','markFired(','computeNextRun(']) {
  check(`exposes ${sym}`, svc.includes(sym))
}
check('rejects FTP source for now',
  /FTP source not yet supported — use URL/.test(svc))
check('rejects non-http(s) sourceUrl',
  /sourceUrl must be a http\(s\) URL/.test(svc))
check('rejects schedule with neither scheduledFor nor cron',
  /Schedule must carry either scheduledFor or cronExpression/.test(svc))
check('validates cron via cron-parser',
  /Invalid cron expression/.test(svc))

console.log('\nCase 2: fireOnce uses parsers + apply')
check('detects fileKind from URL',
  /detectFileKind\(row\.sourceUrl\)/.test(svc))
check('parseFile handles xlsx vs text',
  /parseFile\(fileKind, \{ text, bytes \}\)/.test(svc))
check('applies columnMapping per row',
  /applyMapping\(raw, mapping\)/.test(svc))
check('persists ImportJob with source=url + scheduleId',
  /source: 'url'[\s\S]{0,400}scheduleId: row\.id/.test(svc))
check('runs apply() after create',
  /this\.importService\.apply\(job\.id\)/.test(svc))

console.log('\nCase 3: cron worker')
check('runScheduledImportTickOnce exported',
  /export async function runScheduledImportTickOnce/.test(job))
check('5-min interval',
  /TICK_INTERVAL_MS = 5 \* 60 \* 1000/.test(job))
check('per-row try/catch never wedges the tick',
  /catch \(err\) \{[\s\S]{0,400}status: 'FAILED'/.test(job))
check('disabled rows go SKIPPED',
  /if \(!row\.enabled\)/.test(job) && /status: 'SKIPPED'/.test(job))
check('boots WITHOUT firing immediately',
  !/void runScheduledImportCronOnce\(\)\s*\n\s*tickTimer/.test(job))

console.log('\nCase 4: routes registered')
for (const ep of [
  '/scheduled-imports',
  '/scheduled-imports/:id',
  '/scheduled-imports/:id/enabled',
  '/scheduled-imports/tick',
]) {
  check(`route ${ep}`, routes.includes(`'${ep}'`))
}
check('400 for invalid cron / missing both fields / bad URL',
  /status =[\s\S]{0,400}Invalid cron expression[\s\S]{0,200}sourceUrl must be[\s\S]{0,200}FTP source not yet supported/.test(routes))

console.log('\nCase 5: index.ts wires the cron + routes')
check('imports startScheduledImportCron',
  /startScheduledImportCron/.test(idx))
check('boots the cron',
  /startScheduledImportCron\(\);/.test(idx))
check('registers scheduledImportsRoutes at /api',
  /app\.register\(scheduledImportsRoutes,\s*\{\s*prefix:\s*'\/api'\s*\}\)/.test(idx))

console.log('\nCase 6: cron-registry')
check('scheduled-import registered for manual triggers',
  /'scheduled-import':\s*\(\)\s*=>\s*runScheduledImportCronOnce\(\)/.test(cronReg))

console.log('\nCase 7: end-to-end DB roundtrip')
{
  const id = `verify-w8-4-${Date.now()}`
  await c.query(
    `INSERT INTO "ScheduledImport" (
       id, name, source, "sourceUrl", "targetEntity", "columnMapping",
       "onError", "cronExpression", timezone, "nextRunAt", enabled,
       "runCount", "createdAt", "updatedAt"
     ) VALUES (
       $1, 'Daily supplier feed', 'url', 'https://example.com/feed.csv',
       'product', '{"sku":"SKU","basePrice":"Price"}'::jsonb,
       'skip', '0 6 * * *', 'Europe/Rome', NOW() + INTERVAL '1 day',
       true, 0, NOW(), NOW()
     )`,
    [id],
  )
  const r = await c.query(
    `SELECT name, source, "sourceUrl", "targetEntity", "cronExpression"
       FROM "ScheduledImport" WHERE id = $1`, [id])
  check('row inserted', r.rows.length === 1)
  check('roundtrips sourceUrl + cronExpression',
    r.rows[0].sourceUrl === 'https://example.com/feed.csv' &&
    r.rows[0].cronExpression === '0 6 * * *')
  await c.query(`DELETE FROM "ScheduledImport" WHERE id = $1`, [id])
}

await c.end()

if (failures > 0) {
  console.log(`\n✗ ${failures} assertion(s) failed`)
  process.exit(1)
}
console.log('\n✓ all assertions passed (Wave 8 complete)')
