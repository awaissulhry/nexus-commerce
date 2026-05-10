#!/usr/bin/env node
// Verify W9.4 — scheduled exports + delivery hook. Closes Wave 9.
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

console.log('\nW9.4 — scheduled exports + delivery hook\n')

const svc = fs.readFileSync(
  path.join(repo, 'apps/api/src/services/scheduled-export.service.ts'),
  'utf8',
)
const job = fs.readFileSync(
  path.join(repo, 'apps/api/src/jobs/scheduled-export.job.ts'),
  'utf8',
)
const routes = fs.readFileSync(
  path.join(repo, 'apps/api/src/routes/scheduled-exports.routes.ts'),
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
for (const sym of [
  'class ScheduledExportService',
  'create(',
  'list(',
  'get(',
  'setEnabled(',
  'delete(',
  'findDue(',
  'fireOnce(',
  'markFired(',
  'computeNextRun(',
]) {
  check(`exposes ${sym}`, svc.includes(sym))
}
check('rejects FTP delivery for now',
  /FTP delivery not yet supported — use email or webhook/.test(svc))
check('rejects webhook without http(s) target',
  /webhook delivery requires deliveryTarget as a http\(s\) URL/.test(svc))
check('rejects malformed email target',
  /email delivery target must be a valid email address/.test(svc))
check('rejects schedule with neither scheduledFor nor cron',
  /Schedule must carry either scheduledFor or cronExpression/.test(svc))
check('validates cron via cron-parser',
  /Invalid cron expression/.test(svc))
check('rejects empty columns list',
  /columns is required \(non-empty\)/.test(svc))

console.log('\nCase 2: fireOnce → exportService.create + delivery')
check('runs ExportWizardService.create with runImmediately=true',
  /this\.exportService\.create\(\{[\s\S]{0,400}runImmediately: true/.test(svc))
check('hands jobId + status + bytes + rowCount back',
  /jobId: job\.id[\s\S]{0,200}status: job\.status[\s\S]{0,200}bytes: job\.bytes[\s\S]{0,200}rowCount: job\.rowCount/.test(svc))
check('only delivers when status COMPLETED',
  /if \(job\.status !== 'COMPLETED'\)[\s\S]{0,300}await this\.deliver/.test(svc))

console.log('\nCase 3: delivery transports')
check('email delivery writes a Notification row',
  /this\.prisma\.notification\.create\(\{[\s\S]{0,400}type: 'scheduled-export'/.test(svc))
check('email Notification carries entityType ExportJob',
  /entityType: 'ExportJob'/.test(svc))
check('email Notification href deep-links to exports page',
  /href: `\/bulk-operations\/exports`/.test(svc))
check('webhook delivery POSTs the bytes',
  /method: 'POST'[\s\S]{0,300}body: dl\.bytes/.test(svc))
check('webhook attaches X-Nexus-Schedule-Id + X-Nexus-Job-Id headers',
  /'X-Nexus-Schedule-Id': row\.id/.test(svc) &&
  /'X-Nexus-Job-Id': jobId/.test(svc))
check('webhook failure logs but does not bubble',
  /catch \(err\)[\s\S]{0,200}\[scheduled-export\] webhook delivery failed/.test(svc))

console.log('\nCase 4: cron worker')
check('runScheduledExportTickOnce exported',
  /export async function runScheduledExportTickOnce/.test(job))
check('5-min interval',
  /TICK_INTERVAL_MS = 5 \* 60 \* 1000/.test(job))
check('per-row try/catch never wedges the tick',
  /catch \(err\) \{[\s\S]{0,400}status: 'FAILED'/.test(job))
check('disabled rows go SKIPPED',
  /if \(!row\.enabled\)/.test(job) && /status: 'SKIPPED'/.test(job))
check('boots WITHOUT firing immediately',
  !/void runScheduledExportCronOnce\(\)\s*\n\s*tickTimer/.test(job))

console.log('\nCase 5: routes registered')
for (const ep of [
  '/scheduled-exports',
  '/scheduled-exports/:id',
  '/scheduled-exports/:id/enabled',
  '/scheduled-exports/tick',
]) {
  check(`route ${ep}`, routes.includes(`'${ep}'`))
}
check('400 responses cover every validator branch',
  /Invalid cron expression/.test(routes) &&
  /Schedule must carry/.test(routes) &&
  /Unknown format/.test(routes) &&
  /Unknown delivery/.test(routes) &&
  /columns is required/.test(routes) &&
  /FTP delivery not yet supported/.test(routes) &&
  /webhook delivery requires deliveryTarget/.test(routes) &&
  /email delivery target must be/.test(routes))

console.log('\nCase 6: index.ts wires the cron + routes')
check('imports startScheduledExportCron',
  /startScheduledExportCron/.test(idx))
check('boots the cron',
  /startScheduledExportCron\(\);/.test(idx))
check('registers scheduledExportsRoutes at /api',
  /app\.register\(scheduledExportsRoutes,\s*\{\s*prefix:\s*'\/api'\s*\}\)/.test(idx))

console.log('\nCase 7: cron-registry')
check('scheduled-export registered for manual triggers',
  /'scheduled-export':\s*\(\)\s*=>\s*runScheduledExportCronOnce\(\)/.test(cronReg))

console.log('\nCase 8: end-to-end DB roundtrip')
{
  const id = `verify-w9-4-${Date.now()}`
  await c.query(
    `INSERT INTO "ScheduledExport" (
       id, name, format, "targetEntity", columns, delivery,
       "deliveryTarget", "cronExpression", timezone, "nextRunAt",
       enabled, "runCount", "createdAt", "updatedAt"
     ) VALUES (
       $1, 'Daily product CSV', 'csv', 'product',
       '[{"id":"sku","label":"SKU"}]'::jsonb, 'email',
       'ops@example.com', '0 6 * * *', 'Europe/Rome',
       NOW() + INTERVAL '1 day', true, 0, NOW(), NOW()
     )`,
    [id],
  )
  const r = await c.query(
    `SELECT name, format, "targetEntity", delivery, "deliveryTarget",
            "cronExpression"
       FROM "ScheduledExport" WHERE id = $1`, [id])
  check('row inserted', r.rows.length === 1)
  check('roundtrips delivery target + cronExpression',
    r.rows[0].delivery === 'email' &&
    r.rows[0].deliveryTarget === 'ops@example.com' &&
    r.rows[0].cronExpression === '0 6 * * *')
  await c.query(`DELETE FROM "ScheduledExport" WHERE id = $1`, [id])
}

await c.end()

if (failures > 0) {
  console.log(`\n✗ ${failures} assertion(s) failed`)
  process.exit(1)
}
console.log('\n✓ all assertions passed (Wave 9 complete)')
